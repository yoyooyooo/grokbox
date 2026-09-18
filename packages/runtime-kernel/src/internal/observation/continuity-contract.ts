import { canonicalJson, sha256Text } from "../../hash.ts";

/** The two explicit consumers are not a plugin registry. Native recovery,
 * safety records and reference transactions remain owned by CONT. */
export const CONTINUITY_STORAGE_OWNERS = ["continuity.recovery", "continuity.safety"] as const;
export type ContinuityStorageOwnerId = typeof CONTINUITY_STORAGE_OWNERS[number];
export type ProtectedStorageRef = { owner: ContinuityStorageOwnerId; ref: string; revision: string };
export type ContinuityBlockedBy = "active_reference" | "last_reliable_point" | "effect_unknown" | "capacity" | "busy" | "unavailable" | "unsupported" | "conflict";
export type OwnerMeasurement = {
  owner: ContinuityStorageOwnerId; observedAtMs: number; coverage: "complete" | "partial";
  logicalBytes: number; protectedLogicalBytes: number; reclaimableLogicalBytes: number;
  allocations: Array<{ allocationId: string; allocatedBytes: number }>;
  blockedBy: ContinuityBlockedBy[];
};
export type ReferenceChange = { requestId: string; claimId: string; action: "protect" | "release"; reference: ProtectedStorageRef };
export type ReferenceReceipt = { requestId: string; claimId: string; reference: ProtectedStorageRef;
  state: "protected" | "released" | "blocked" | "conflict"; blockedBy: ContinuityBlockedBy[] };
export type OwnedMaintenanceReceipt = { owner: ContinuityStorageOwnerId; state: "maintained" | "blocked";
  reclaimedBytes: number; blockedBy: ContinuityBlockedBy[] };
/** All three mutating methods/GC share the owner's actual lock/transaction.
 * Request IDs are content-bound; release removes only the exact claim+revision.
 * maintain receives no paths or diagnostic TTL, and may not release references.
 * Safety capacity failure blocks the domain's new effect, never just this view. */
export type ContinuityStorageOwner = {
  owner: ContinuityStorageOwnerId;
  measure: () => Promise<OwnerMeasurement>;
  changeReference: (change: ReferenceChange) => Promise<ReferenceReceipt>;
  maintain: (input: { nowMs: number; maxItems: number }) => Promise<OwnedMaintenanceReceipt>;
};
export type ContinuityStorageOwners = { recovery?: ContinuityStorageOwner; safety?: ContinuityStorageOwner };

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const invalid = (): never => { throw new Error("continuity_contract_unsupported"); };
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return invalid();
  for (const key of Object.keys(v)) if (!keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(v, key)!)) return invalid();
  return v as Record<string, unknown>;
}
const owners = (v: unknown): v is ContinuityStorageOwnerId => CONTINUITY_STORAGE_OWNERS.includes(v as never);
const BLOCKED: ContinuityBlockedBy[] = ["active_reference", "last_reliable_point", "effect_unknown", "capacity", "busy", "unavailable", "unsupported", "conflict"];
function blocked(v: unknown): ContinuityBlockedBy[] {
  if (!Array.isArray(v) || v.length > BLOCKED.length || v.some(x => !BLOCKED.includes(x))) return invalid();
  return [...new Set(v)];
}
export function protectedStorageRef(input: unknown): ProtectedStorageRef {
  const v = object(input, ["owner", "ref", "revision"]);
  if (!owners(v.owner) || !token(v.ref) || !token(v.revision)) return invalid();
  return { owner: v.owner, ref: v.ref, revision: v.revision };
}
export function referenceChange(input: unknown): ReferenceChange {
  const v = object(input, ["requestId", "claimId", "action", "reference"]);
  if (!uuid(v.requestId) || !uuid(v.claimId) || !["protect", "release"].includes(String(v.action))) return invalid();
  return { requestId: v.requestId, claimId: v.claimId, action: v.action as ReferenceChange["action"], reference: protectedStorageRef(v.reference) };
}
export function referenceReceipt(input: unknown, request: ReferenceChange): ReferenceReceipt {
  const v = object(input, ["requestId", "claimId", "reference", "state", "blockedBy"]), ref = protectedStorageRef(v.reference);
  if (v.requestId !== request.requestId || v.claimId !== request.claimId || canonicalJson(ref) !== canonicalJson(request.reference)
    || ![request.action === "protect" ? "protected" : "released", "blocked", "conflict"].includes(String(v.state))) return invalid();
  return { requestId: request.requestId, claimId: request.claimId, reference: ref,
    state: v.state as ReferenceReceipt["state"], blockedBy: blocked(v.blockedBy) };
}
export function ownerMeasurement(input: unknown, expected: ContinuityStorageOwnerId): OwnerMeasurement {
  const v = object(input, ["owner", "observedAtMs", "coverage", "logicalBytes", "protectedLogicalBytes", "reclaimableLogicalBytes", "allocations", "blockedBy"]);
  if (v.owner !== expected || !uint(v.observedAtMs) || !["complete", "partial"].includes(String(v.coverage))
    || !uint(v.logicalBytes) || !uint(v.protectedLogicalBytes) || !uint(v.reclaimableLogicalBytes)
    || v.protectedLogicalBytes + v.reclaimableLogicalBytes > v.logicalBytes || !Array.isArray(v.allocations) || v.allocations.length > 128) return invalid();
  const allocations = v.allocations.map(raw => {
    const a = object(raw, ["allocationId", "allocatedBytes"]); if (!hash(a.allocationId) || !uint(a.allocatedBytes)) return invalid();
    return { allocationId: a.allocationId, allocatedBytes: a.allocatedBytes };
  });
  if (new Set(allocations.map(a => a.allocationId)).size !== allocations.length) return invalid();
  return { owner: expected, observedAtMs: v.observedAtMs, coverage: v.coverage as OwnerMeasurement["coverage"],
    logicalBytes: v.logicalBytes, protectedLogicalBytes: v.protectedLogicalBytes, reclaimableLogicalBytes: v.reclaimableLogicalBytes,
    allocations, blockedBy: blocked(v.blockedBy) };
}
export function ownedMaintenanceReceipt(input: unknown, expected: ContinuityStorageOwnerId): OwnedMaintenanceReceipt {
  const v = object(input, ["owner", "state", "reclaimedBytes", "blockedBy"]);
  if (v.owner !== expected || !["maintained", "blocked"].includes(String(v.state)) || !uint(v.reclaimedBytes)) return invalid();
  return { owner: expected, state: v.state as OwnedMaintenanceReceipt["state"], reclaimedBytes: v.reclaimedBytes, blockedBy: blocked(v.blockedBy) };
}

export const CONTINUITY_KINDS = ["ownership_lost", "ownership_observed", "recovery_degraded", "operation_unknown", "operation_observed", "inbound_window", "source_gap"] as const;
export const CONTINUITY_GAPS = ["unavailable", "retention", "incomplete_page", "unsupported_schema", "sequence_gap", "conflict"] as const;
export type ContinuitySource = { scopeId: string; source: "ownership" | "recovery" | "operation" | "inbound"; generation: string };
export type ContinuityEvent = {
  name: "continuity_observation"; schemaVersion: 1; at: string;
  scopeId: string; source: ContinuitySource["source"]; generation: string; sourceInstanceId: string;
  /** Zero-based source sequence, matching existing journal/monitor watermarks. */
  eventId: string; sourceSequence: number; agentId: string; occurrenceId: string;
  kind: typeof CONTINUITY_KINDS[number]; operationId?: string; dutyId?: string;
  coverage: { state: "observed" | "gap" | "unsupported"; fromAtMs: number; throughAtMs: number; gapCodes: Array<typeof CONTINUITY_GAPS[number]> };
  inboundCount: number | null; evidenceRefs: ProtectedStorageRef[];
};
export function continuitySource(input: unknown): ContinuitySource {
  const v = object(input, ["scopeId", "source", "generation"]);
  if (!hash(v.scopeId) || !["ownership", "recovery", "operation", "inbound"].includes(String(v.source)) || !token(v.generation)) return invalid();
  return { scopeId: v.scopeId, source: v.source as ContinuitySource["source"], generation: v.generation };
}
export const continuitySourceKey = (source: ContinuitySource) => sha256Text(canonicalJson(["continuity-v1", continuitySource(source)]));
export function projectContinuityEvent(input: unknown): ContinuityEvent | null {
  try {
    const v = object(input, ["name", "schemaVersion", "at", "scopeId", "source", "generation", "sourceInstanceId", "eventId", "sourceSequence", "agentId", "occurrenceId", "kind", "operationId", "dutyId", "coverage", "inboundCount", "evidenceRefs"]);
    const source = continuitySource({ scopeId: v.scopeId, source: v.source, generation: v.generation });
    if (v.name !== "continuity_observation" || v.schemaVersion !== 1 || typeof v.at !== "string" || v.at.length > 40 || !Number.isFinite(Date.parse(v.at))
      || v.sourceInstanceId !== continuitySourceKey(source) || !uuid(v.eventId) || !uint(v.sourceSequence)
      || !uuid(v.agentId) || !uuid(v.occurrenceId) || !CONTINUITY_KINDS.includes(v.kind as never)) return null;
    if (v.operationId !== undefined && !uuid(v.operationId) || v.dutyId !== undefined && !uuid(v.dutyId)) return null;
    const c = object(v.coverage, ["state", "fromAtMs", "throughAtMs", "gapCodes"]);
    if (!["observed", "gap", "unsupported"].includes(String(c.state)) || !uint(c.fromAtMs) || !uint(c.throughAtMs) || c.fromAtMs > c.throughAtMs
      || c.throughAtMs > Date.parse(v.at) || !Array.isArray(c.gapCodes) || c.gapCodes.length > CONTINUITY_GAPS.length
      || c.gapCodes.some(x => !CONTINUITY_GAPS.includes(x)) || (c.state === "observed") !== (c.gapCodes.length === 0)) return null;
    if (!Array.isArray(v.evidenceRefs) || v.evidenceRefs.length > 8) return null;
    const inbound = v.kind === "inbound_window" && c.state === "observed";
    if (inbound ? !uint(v.inboundCount) : v.inboundCount !== null) return null;
    if (v.kind === "ownership_lost" && (source.source !== "ownership" || c.state !== "observed")) return null;
    if (v.kind === "source_gap" && c.state === "observed" || v.kind === "inbound_window" && source.source !== "inbound") return null;
    return { name: "continuity_observation", schemaVersion: 1, at: v.at, ...source, sourceInstanceId: String(v.sourceInstanceId),
      eventId: v.eventId, sourceSequence: v.sourceSequence, agentId: v.agentId, occurrenceId: v.occurrenceId, kind: v.kind as ContinuityEvent["kind"],
      ...(v.operationId ? { operationId: String(v.operationId) } : {}), ...(v.dutyId ? { dutyId: String(v.dutyId) } : {}),
      coverage: { state: c.state as ContinuityEvent["coverage"]["state"], fromAtMs: c.fromAtMs, throughAtMs: c.throughAtMs, gapCodes: [...new Set(c.gapCodes)] },
      inboundCount: v.inboundCount as number | null, evidenceRefs: v.evidenceRefs.map(protectedStorageRef) };
  } catch { return null; }
}
