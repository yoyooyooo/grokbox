import { canonicalJson, sha256Text } from "./hash.ts";
export * from "./internal/commands/routine-provision-contract.ts";

/** Native definitions remain authoritative. These are read projections, not a
 * scheduler, a recovery archive, or permission to invoke a webhook. */
export const NATIVE_ROUTINE_LIMIT = 100;
export const NATIVE_ROUTINE_MAX_BYTES = 512 * 1024;
export type RoutineAction = "list" | "show" | "enable" | "disable" | "delete";
export type RoutineFailure = "invalid_input" | "unsupported_shape" | "read_unavailable" | "not_found_in_window" | "revision_conflict" | "unsupported_trigger" | "confirmation_required" | "generation_changed" | "outcome_unknown";
export class RoutineError extends Error {
  constructor(readonly reason: RoutineFailure) { super(`routine_${reason}`); this.name = "RoutineError"; }
}
const fail = (reason: RoutineFailure = "unsupported_shape"): never => { throw new RoutineError(reason); };
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  return v as Record<string, unknown>;
}
function own(v: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(v, key);
  if (descriptor && !("value" in descriptor)) return fail();
  return descriptor?.value;
}
export function routineAgentId(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return fail("invalid_input");
  return v.toLowerCase();
}
export function routineId(v: unknown): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v)) return fail("invalid_input");
  return v;
}
export function routineRevision(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) return fail("invalid_input");
  return v;
}
function text(v: unknown, limit: number): string {
  if (typeof v !== "string" || v.length > limit || /\u0000/.test(v)) return fail();
  return v;
}
function time(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return fail();
  return v;
}
export type RoutineView = {
  id: string; name: string; enabled: boolean;
  trigger: { type: "webhook" } | { type: "cron"; schedule: string } | { type: "unsupported" };
  revision: string; definitionRevision: string; mutable: boolean;
  createdAtMs: number | null; lastRunAtMs: number | null; nextRunAtMs: number | null;
  promptIncluded: false; credentialsIncluded: false; nativeCompareAndSwap: false;
};
export type RoutineCatalog = { schemaVersion: 1; agentId: string; routines: RoutineView[];
  coverage: { kind: "native_returned_window"; limit: number; atLimit: boolean; complete: false } };

/** Decode only the established native record surface. No raw prompt, path,
 * provenance text, run output, webhook address, key or unknown field escapes. */
export function projectNativeRoutines(agentId: string, value: unknown): RoutineCatalog {
  const id = routineAgentId(agentId);
  if (!Array.isArray(value) || value.length > NATIVE_ROUTINE_LIMIT) return fail();
  let measured = 0;
  const seen = new Set<string>();
  const routines = value.map(raw => {
    const v = record(raw), rid = routineId(own(v, "id")), name = text(own(v, "name"), 512), prompt = text(own(v, "prompt"), 128 * 1024);
    const enabled = own(v, "isEnabled"); if (typeof enabled !== "boolean" || seen.has(rid)) return fail(); seen.add(rid);
    const trigger = record(own(v, "trigger")), kind = own(trigger, "type");
    let safeTrigger: RoutineView["trigger"] = { type: "unsupported" };
    if (kind === "webhook" && Object.keys(trigger).every(k => k === "type")) safeTrigger = { type: "webhook" };
    if (kind === "cron" && Object.keys(trigger).every(k => ["type", "schedule"].includes(k))) safeTrigger = { type: "cron", schedule: text(own(trigger, "schedule"), 512) };
    const session = own(v, "sessionId");
    if (session !== undefined && session !== null) text(session, 128);
    const createdAtMs = time(own(v, "createdAt"));
    // Hash only defined fields. Unsupported shapes remain read-only and do not
    // need a fabricated canonical digest of arbitrary nested provider data.
    const definitionRevision = sha256Text(canonicalJson({ id: rid, name, prompt, trigger: safeTrigger, createdAtMs, session: session ?? null }));
    measured += new TextEncoder().encode(name).length + new TextEncoder().encode(prompt).length + 2048;
    if (measured > NATIVE_ROUTINE_MAX_BYTES) return fail();
    return { id: rid, name, enabled, trigger: safeTrigger, definitionRevision,
      revision: sha256Text(canonicalJson({ definitionRevision, enabled })),
      mutable: safeTrigger.type !== "unsupported" && (session === undefined || session === null || session === "default"),
      createdAtMs, lastRunAtMs: time(own(v, "lastRunAt")), nextRunAtMs: time(own(v, "nextRunAt")),
      promptIncluded: false as const, credentialsIncluded: false as const, nativeCompareAndSwap: false as const };
  });
  return { schemaVersion: 1, agentId: id, routines, coverage: { kind: "native_returned_window", limit: NATIVE_ROUTINE_LIMIT, atLimit: routines.length === NATIVE_ROUTINE_LIMIT, complete: false } };
}
export type RoutineSnapshot = { catalog: RoutineCatalog; generation: string };
export type RoutineCommand = { action: RoutineAction; agentId: string; routineId?: string; expectedRevision?: string; confirmed?: boolean; operationId?: string };
export function validateRoutineCommand(value: RoutineCommand): RoutineCommand {
  const raw = record(value);
  if (Object.keys(raw).some(k => !["action", "agentId", "routineId", "expectedRevision", "confirmed", "operationId"].includes(k))) return fail("invalid_input");
  for (const key of Object.keys(raw)) own(raw, key);
  if (!["list", "show", "enable", "disable", "delete"].includes(value.action)) return fail("invalid_input");
  const agentId = routineAgentId(value.agentId);
  if (value.action !== "list") routineId(value.routineId);
  if (value.action !== "list" && value.action !== "show") {
    if (value.confirmed !== true) return fail("confirmation_required");
    routineRevision(value.expectedRevision);
    if (typeof value.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operationId)) return fail("invalid_input");
  }
  return { ...value, agentId };
}
export type RoutineOperationReceipt = { schemaVersion: 1; action: RoutineAction; agentId: string; routineId: string;
  operationId: string; state: "unchanged" | "requested_state_observed" | "absent_in_returned_window";
  beforeRevision: string; afterRevision: string | null; nativeCompareAndSwap: false; automaticRetry: false;
  inFlightRunsCancelled: false; webhookInvoked: false; effectProof: "preflight_and_readback_only" };

/** Reproject the daemon boundary too: never trust extra nested fields merely
 * because the native read was performed by another grokbox process. */
export function projectRoutineResult(command: RoutineCommand, value: unknown): RoutineCatalog | RoutineOperationReceipt {
  const v = record(value);
  if (own(v, "schemaVersion") !== 1 || own(v, "agentId") !== command.agentId) return fail();
  if (command.action === "list" || command.action === "show") {
    const items = own(v, "routines"), coverage = record(own(v, "coverage"));
    if (!Array.isArray(items) || items.length > NATIVE_ROUTINE_LIMIT || own(coverage, "kind") !== "native_returned_window"
      || own(coverage, "limit") !== NATIVE_ROUTINE_LIMIT || typeof own(coverage, "atLimit") !== "boolean" || own(coverage, "complete") !== false) return fail();
    const ids = new Set<string>();
    const routines: RoutineView[] = items.map(item => {
      const r = record(item), id = routineId(own(r, "id")), t = record(own(r, "trigger")), kind = own(t, "type");
      if (ids.has(id) || !["webhook", "cron", "unsupported"].includes(String(kind)) || typeof own(r, "enabled") !== "boolean" || typeof own(r, "mutable") !== "boolean"
        || own(r, "promptIncluded") !== false || own(r, "credentialsIncluded") !== false || own(r, "nativeCompareAndSwap") !== false) return fail();
      ids.add(id);
      return { id, name: text(own(r, "name"), 512), enabled: own(r, "enabled") as boolean,
        trigger: kind === "cron" ? { type: "cron", schedule: text(own(t, "schedule"), 512) } : { type: kind as "webhook" | "unsupported" },
        mutable: own(r, "mutable") as boolean, revision: routineRevision(own(r, "revision")), definitionRevision: routineRevision(own(r, "definitionRevision")),
        createdAtMs: time(own(r, "createdAtMs")), lastRunAtMs: time(own(r, "lastRunAtMs")), nextRunAtMs: time(own(r, "nextRunAtMs")),
        promptIncluded: false, credentialsIncluded: false, nativeCompareAndSwap: false };
    });
    if (command.action === "show" && (routines.length !== 1 || routines[0]!.id !== command.routineId)) return fail();
    return { schemaVersion: 1, agentId: command.agentId, routines,
      coverage: { kind: "native_returned_window", limit: NATIVE_ROUTINE_LIMIT, atLimit: own(coverage, "atLimit") as boolean, complete: false } };
  }
  if (own(v, "action") !== command.action || own(v, "routineId") !== command.routineId || own(v, "operationId") !== command.operationId
    || !["unchanged", "requested_state_observed", "absent_in_returned_window"].includes(String(own(v, "state")))
    || own(v, "nativeCompareAndSwap") !== false || own(v, "automaticRetry") !== false || own(v, "inFlightRunsCancelled") !== false
    || own(v, "webhookInvoked") !== false || own(v, "effectProof") !== "preflight_and_readback_only") return fail();
  const state = own(v, "state") as RoutineOperationReceipt["state"], beforeRevision = routineRevision(own(v, "beforeRevision"));
  const afterRevision = own(v, "afterRevision") === null ? null : routineRevision(own(v, "afterRevision"));
  if (beforeRevision !== command.expectedRevision || (command.action === "delete"
    ? state !== "absent_in_returned_window" || afterRevision !== null
    : state === "absent_in_returned_window" || afterRevision === null
      || state === "unchanged" && afterRevision !== beforeRevision
      || state === "requested_state_observed" && afterRevision === beforeRevision)) return fail();
  return { schemaVersion: 1, agentId: command.agentId, action: command.action, routineId: command.routineId!, operationId: command.operationId!,
    state, beforeRevision, afterRevision,
    nativeCompareAndSwap: false, automaticRetry: false, inFlightRunsCancelled: false, webhookInvoked: false, effectProof: "preflight_and_readback_only" };
}
