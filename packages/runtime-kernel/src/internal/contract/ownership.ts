import { ADMISSION_WAIT_MS } from "./limits.ts";
import { projectServerActivitySnapshot } from "./activity-observation.ts";
import { OWNERSHIP_READ_ERRORS, ownershipReadObservationFromSnapshot, type OwnershipReadObservation } from "./ownership-observation.ts";

// Shared, effect-free ownership facts. Display snapshots are not execution leases.
export type OwnershipState = "confirmed_box" | "confirmed_temporal" | "conflict" | "unconfirmed";
export type OwnershipRefusalClass = "temporal" | "conflict" | "unconfirmed" | "unavailable";
export const OWNERSHIP_EVIDENCE_MAX_AGE_MS = 5_000;
export const OWNERSHIP_SERVER_CACHE_MS = 2_000;
export const OWNERSHIP_WAIT_MS = 10_000;
// Once Server ownership is part of admission, the old local-only 500ms budget
// cannot wrap the entire RPC. This is one bounded combined admission budget.
export const OWNERSHIP_ADMISSION_WAIT_MS = OWNERSHIP_WAIT_MS + ADMISSION_WAIT_MS;
export const OWNERSHIP_MAX_TARGETS = 32;
export const OWNERSHIP_LOCAL_SOURCE = "Host.native-local-ownership" as const;

export function chunkOwnershipTargets(ids: readonly string[]): string[][] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += OWNERSHIP_MAX_TARGETS) {
    chunks.push(unique.slice(i, i + OWNERSHIP_MAX_TARGETS));
  }
  return chunks;
}

const rec = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) result[key] = descriptor.value;
  }
  return result;
};
const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
const safeTime = (value: unknown) => typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
const iso = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const harness = (value: unknown) => {
  const h = rec(value).harness;
  return h === "box" || h === "temporal" ? h : "unknown";
};
const inList = (value: unknown, list: readonly string[]) => typeof value === "string" && list.includes(value);

/** Finite facts, independent of CLI, auth transport and any persistent UI index. */
export function inspectOwnership(input: { agentIds: string[]; snapshot: unknown; gatewayChanged?: boolean }) {
  const snap = rec(input.snapshot);
  const snapshotValid = (snap.schemaVersion === 1 || snap.schemaVersion === 2 || snap.schemaVersion === 3) && (snap.state === "observed" || snap.state === "unavailable")
    && snap.source === "Host.official-client/ListGrokBotAgents" && Array.isArray(snap.agents)
    && snap.agents.length <= OWNERSHIP_MAX_TARGETS && iso(snap.observedAt) !== null && iso(snap.completedAt) !== null;
  const errors = OWNERSHIP_READ_ERRORS;
  const errorCode = snapshotValid ? inList(snap.errorCode, errors) ? snap.errorCode as string : null
    : inList(snap.state, errors) ? snap.state as string : "ownership_bridge_unavailable";
  const rows: unknown[] = snapshotValid ? snap.agents as unknown[] : [];
  const window = rec(snap.localMigrationWindow);
  const windowKinds = [rec(window.before).kind, rec(window.after).kind];
  const migration = windowKinds.includes("active") ? "active"
    : windowKinds.every(kind => kind === "inactive") ? "inactive" : "unknown";
  const execution = rec(snap.localExecution);
  const executionBefore = rec(execution.before), executionAfter = rec(execution.after);
  const localExecution = snap.schemaVersion !== 3 ? "not_observed"
    : executionBefore.allowed === false || executionAfter.allowed === false ? "paused"
    : executionBefore.bound === false || executionAfter.bound === false ? "unbound"
    : executionBefore.allowed === true && executionAfter.allowed === true && executionBefore.bound === true && executionAfter.bound === true ? "ready" : "unknown";
  const scope = rec(snap.scope);
  const scopeId = typeof scope.id === "string" && /^[a-f0-9]{64}$/.test(scope.id) ? scope.id : null;
  const readObservation = ownershipReadObservationFromSnapshot(snap);
  const activityObservation = projectServerActivitySnapshot(snap.activityObservation);
  return {
    ...(activityObservation ? { activityObservation } : {}),
    ...(readObservation ? { readObservation } : {}),
    source: snapshotValid ? snap.source as string : "unavailable",
    observedAt: iso(snap.observedAt), completedAt: iso(snap.completedAt),
    serverRead: { state: snapshotValid ? snap.state as string : "unavailable", errorCode },
    localMigrationWindow: migration,
    serverMigration: "not_observed",
    desktopRoute: "not_observed",
    productionAccepted: false,
    ...(snap.schemaVersion === 2 || snap.schemaVersion === 3 ? { scope: { id: scopeId, stable: scope.stable === true && scopeId !== null }, serverObservedAt: iso(snap.serverObservedAt) } : {}),
    localExecution,
    agents: input.agentIds.map(agentId => {
      const matches = rows.filter(row => rec(row).agentId === agentId);
      const row = matches.length === 1 ? rec(matches[0]) : {};
      const serverRow = rec(row.server);
      const server = row.server == null ? null : {
        agentId: safeId(serverRow.agentId), serverId: safeId(serverRow.serverId),
        harness: harness(serverRow), legacyAgentId: safeId(serverRow.legacyAgentId),
        createdAtMs: safeTime(serverRow.createdAtMs), updatedAtMs: safeTime(serverRow.updatedAtMs),
        viewerIsOwner: typeof serverRow.viewerIsOwner === "boolean" ? serverRow.viewerIsOwner : null,
      };
      const rawLocal = rec(row.local);
      const before = { harness: harness(rawLocal.before), serverId: safeId(rec(rawLocal.before).serverId) };
      const after = { harness: harness(rawLocal.after), serverId: safeId(rec(rawLocal.after).serverId) };
      const stable = rawLocal.stable === true && before.harness === after.harness && before.serverId === after.serverId;
      const reasons: string[] = [];
      let state: OwnershipState = "unconfirmed";
      if (input.gatewayChanged) reasons.push("gateway_generation_changed");
      if (!snapshotValid || snap.state !== "observed") reasons.push("server_read_unavailable");
      if (row.serverEvidence !== "found" || matches.length !== 1) reasons.push(row.serverEvidence === "ambiguous" || matches.length > 1 ? "ambiguous_identity" : "server_identity_not_returned");
      if (!stable) reasons.push("local_identity_unstable_or_missing");
      if (server?.agentId !== agentId || !server?.serverId || server.harness === "unknown" || before.harness === "unknown" || !before.serverId) reasons.push("identity_fields_unconfirmed");
      if (reasons.length === 0 && server) {
        if (server.serverId !== before.serverId || server.harness !== before.harness) {
          state = "conflict";
          if (server.serverId !== before.serverId) reasons.push("server_id_mismatch");
          if (server.harness !== before.harness) reasons.push("harness_mismatch");
        } else state = server.harness === "box" ? "confirmed_box" : "confirmed_temporal";
      }
      const blockers = [...reasons];
      if (state === "confirmed_temporal") blockers.push("host_patch_not_on_server_execution_path");
      if (server?.viewerIsOwner === false) blockers.push("viewer_not_owner");
      if (migration !== "inactive") blockers.push(migration === "active" ? "local_migration_window_active" : "local_migration_window_unknown");
      if (localExecution !== "ready") blockers.push(localExecution === "not_observed" ? "native_execution_not_observed" : `native_execution_${localExecution}`);
      blockers.push("desktop_route_not_observed", "model_roundtrip_not_verified");
      return { agentId, state, server,
        serverEvidence: inList(row.serverEvidence, ["found", "not_returned", "ambiguous", "unavailable"]) ? row.serverEvidence as string : "unavailable",
        local: { before, after, stable }, reasons, blockers,
        managedEligibility: state === "confirmed_box" && migration === "inactive" && server?.viewerIsOwner !== false
          && (snap.schemaVersion !== 3 || localExecution === "ready") ? "ownership_only" : "blocked",
        nextAction: state === "conflict" ? "resolve_server_local_identity_conflict" : state === "confirmed_temporal" ? "requires_supported_official_migration_or_server_integration"
          : state === "confirmed_box" ? "verify_original_app_and_model_roundtrip" : "obtain_valid_identity_evidence",
      };
    }),
  };
}

/** Cache only registration facts. The local execution/window/identity fields in
 * the original snapshot deliberately do not survive this projection. */
export function remoteOwnershipEvidence(agentId: string, snapshot: unknown) {
  const fact = inspectOwnership({ agentIds: [agentId], snapshot });
  return {
    source: fact.source, observedAt: fact.observedAt, completedAt: fact.completedAt,
    serverObservedAt: fact.serverObservedAt, scope: fact.scope,
    state: fact.serverRead.state, errorCode: fact.serverRead.errorCode,
    readObservation: fact.readObservation,
    agents: fact.agents.map(row => ({ agentId: row.agentId, server: row.server, serverEvidence: row.serverEvidence })),
  };
}
export type RemoteOwnershipEvidence = ReturnType<typeof remoteOwnershipEvidence>;

/** Native-local witness is a capability-limited observation, never permission.
 * Old peers returning a registration snapshot for a local-only request fail
 * validation rather than being mistaken for a refreshed local execution state. */
export function inspectNativeOwnershipLocal(input: { agentId: string; snapshot: unknown; nowMs: number }) {
  const value = rec(input.snapshot);
  const scope = rec(value.scope);
  const scopeId = typeof scope.id === "string" && /^[a-f0-9]{64}$/.test(scope.id) ? scope.id : null;
  const observedAt = iso(value.observedAt), completedAt = iso(value.completedAt);
  const times = [observedAt, completedAt].map(time => time ? Date.parse(time) : NaN);
  const rows = Array.isArray(value.agents) ? value.agents : [];
  const matches = rows.filter(row => rec(row).agentId === input.agentId);
  const row = matches.length === 1 ? rec(matches[0]) : {};
  const raw = rec(row.local);
  const before = { harness: harness(raw.before), serverId: safeId(rec(raw.before).serverId) };
  const after = { harness: harness(raw.after), serverId: safeId(rec(raw.after).serverId) };
  const stable = raw.stable === true && before.harness === after.harness && before.serverId === after.serverId;
  const execution = rec(value.localExecution);
  const executionBefore = rec(execution.before), executionAfter = rec(execution.after);
  const window = rec(value.localMigrationWindow);
  const valid = value.schemaVersion === 1 && value.source === OWNERSHIP_LOCAL_SOURCE && value.state === "observed"
    && scope.stable === true && scopeId !== null && rows.length <= OWNERSHIP_MAX_TARGETS && matches.length === 1
    && Number.isFinite(input.nowMs) && input.nowMs >= 0
    && times.every(time => Number.isFinite(time) && time <= input.nowMs && input.nowMs - time <= OWNERSHIP_EVIDENCE_MAX_AGE_MS)
    && times[0]! <= times[1]!;
  return {
    valid, scopeId, observedAt, completedAt,
    ready: valid && stable && before.serverId !== null && before.harness !== "unknown"
      && executionBefore.allowed === true && executionAfter.allowed === true
      && executionBefore.bound === true && executionAfter.bound === true
      && rec(window.before).kind === "inactive" && rec(window.after).kind === "inactive",
    local: { before, after, stable },
    localExecution: { before: { allowed: executionBefore.allowed === true, bound: executionBefore.bound === true },
      after: { allowed: executionAfter.allowed === true, bound: executionAfter.bound === true } },
    localMigrationWindow: { before: { kind: rec(window.before).kind === "inactive" ? "inactive" : "unknown" },
      after: { kind: rec(window.after).kind === "inactive" ? "inactive" : "unknown" } },
  };
}

export function decideOwnershipWithLocal(input: {
  agentId: string; remote: RemoteOwnershipEvidence; localSnapshot: unknown; nowMs: number;
}): OwnershipDecision {
  const local = inspectNativeOwnershipLocal({ agentId: input.agentId, snapshot: input.localSnapshot, nowMs: input.nowMs });
  if (!local.valid) return refuse("ownership_bridge_unavailable", undefined, input.remote.readObservation);
  if (!local.ready) return refuse("native_execution_not_ready", undefined, input.remote.readObservation);
  if (input.remote.scope?.id !== local.scopeId) return refuse("ownership_identity_changed", undefined, input.remote.readObservation);
  return decideManagedOwnership({ agentId: input.agentId, nowMs: input.nowMs, snapshot: {
    ...input.remote, schemaVersion: 3,
    // Keep the remote request's original beginning, not the local reread time.
    completedAt: local.completedAt,
    localMigrationWindow: local.localMigrationWindow, localExecution: local.localExecution,
    agents: input.remote.agents.map(row => ({ ...row, local: local.local })),
  } });
}

/** An opaque evidence identity, not permission and never accepted from a run-step body. */
export type OwnershipAdmission = { scopeId: string; serverId: string; observedAtMs: number };
export type OwnershipDecision =
  | { ok: true; evidence: OwnershipAdmission }
  | { ok: false; reason: string; class: OwnershipRefusalClass; ownershipRead?: OwnershipReadObservation };

const UNAVAILABLE_REASONS = new Set([
  "ownership_reader_unavailable",
  "ownership_read_unavailable",
  "ownership_gateway_mismatch",
  "ownership_bridge_unavailable",
  "server_read_unavailable",
  "ownership_clock_unavailable",
  "native_execution_not_ready",
]);
const CONFLICT_REASONS = new Set(["harness_mismatch", "server_id_mismatch"]);

export function classifyManagedOwnershipRefusal(reason: string, state?: OwnershipState): OwnershipRefusalClass {
  if (state === "confirmed_temporal" || reason === "confirmed_temporal") return "temporal";
  if (state === "conflict" || CONFLICT_REASONS.has(reason)) return "conflict";
  if (UNAVAILABLE_REASONS.has(reason)) return "unavailable";
  return "unconfirmed";
}

function refuse(reason: string, state?: OwnershipState, ownershipRead?: OwnershipReadObservation): OwnershipDecision {
  return { ok: false, reason, class: classifyManagedOwnershipRefusal(reason, state), ...(ownershipRead ? { ownershipRead } : {}) };
}

export function decideManagedOwnership(input: { agentId: string; snapshot: unknown; nowMs: number; gatewayChanged?: boolean }): OwnershipDecision {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) return refuse("ownership_clock_unavailable");
  const fact = inspectOwnership({ ...input, agentIds: [input.agentId] });
  const row = fact.agents[0];
  if (!row || row.managedEligibility !== "ownership_only") {
    const reason = row?.state === "confirmed_temporal" ? "confirmed_temporal" : row?.reasons[0] ?? "ownership_unconfirmed";
    return refuse(reason, row?.state, fact.readObservation);
  }
  // Older schemas remain inspectable; an inactive migration window alone is
  // not permission to run during native startup/recovery/recreation pauses.
  if (fact.localExecution !== "ready") return refuse("native_execution_not_ready", row.state, fact.readObservation);
  if (!fact.scope?.id || !fact.scope.stable) return refuse("ownership_scope_unconfirmed", row.state, fact.readObservation);
  const times = [fact.observedAt, fact.completedAt, fact.serverObservedAt].map(value => value ? Date.parse(value) : NaN);
  if (times.some(time => !Number.isFinite(time) || time > input.nowMs || input.nowMs - time > OWNERSHIP_EVIDENCE_MAX_AGE_MS)
    || times[0]! > times[1]!) return refuse("ownership_evidence_stale", row.state, fact.readObservation);
  return { ok: true, evidence: { scopeId: fact.scope.id, serverId: row.server!.serverId!, observedAtMs: times[2]! } };
}
