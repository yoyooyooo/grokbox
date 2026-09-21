import { projectHostCompileReceipt, type HostCompileReceipt } from "./host-compilation.ts";

/** Registration/observed boundaries are evidence, never an execution grant.
 * A successful callback does not prove its caller used the result correctly. */
export const HOST_WITNESS_CAPABILITIES = ["session", "retry", "context", "ownership", "run-observer", "alert-observer", "server-activity", "receiver-model", "continuity"] as const;
export type HostWitnessCapability = typeof HOST_WITNESS_CAPABILITIES[number];
export const HOST_WITNESS_REQUIRED: Record<"identity" | "route", readonly HostWitnessCapability[]> = {
  identity: ["session", "ownership"], route: ["session", "retry", "context", "ownership", "run-observer", "alert-observer"],
};
export const HOST_WITNESS_STAGES = ["session-enter", "native-selected", "managed-selected", "stream-enter", "terminal-consumed", "managed-failure-recognized", "lease-open", "lease-close", "preflight-settled", "checkpoint-settled", "managed-stream-lease-present", "managed-stream-lease-missing"] as const;
export type HostWitnessStage = typeof HOST_WITNESS_STAGES[number];
export type HostWitnessNote = { capability: HostWitnessCapability; stage: HostWitnessStage; outcome: "observed" | "returned" | "threw"; agentId?: string; turnId?: string; stepId?: string };
export type HostWitnessEvent = { sequence: number; atMs: number; capability: HostWitnessCapability; stage: HostWitnessStage; outcome: HostWitnessNote["outcome"]; correlation: string | null };
export type HostWitnessRow = { id: HostWitnessCapability; required: boolean; missingSlices: string[]; handles: "present" | "absent" | "changed" | "not-required" };
/** A constant-size, same-generation record of direct observations. It survives
 * detail-ring eviction; it is not an expected-invocation counter or permission. */
export type HostLeaseOpportunityLedger = { observed: number; missing: number; firstMissing: HostWitnessEvent | null; last: HostWitnessEvent | null };
export type HostWitnessSnapshot = { version: 2; challenge: string; sequence: number; observedAtMs: number; compilation: HostCompileReceipt;
  capabilities: HostWitnessRow[]; events: HostWitnessEvent[]; eventsDropped: number; untrackedSlices: string[];
  leaseOpportunity: HostLeaseOpportunityLedger;
  coverage: "registered-handles-and-recorded-boundaries"; opportunityCoverage: "not-observed" | "managed-main-stream-entry"; qualified: false };
export type HostWitnessObservation = { state: "not-observed" | "current" | "unavailable" | "invalid" | "different-generation";
  reason: "not-requested" | "no-current-compilation" | "unsupported-reader" | "read-unavailable" | "invalid-reply" | "generation-changed" | "matched";
  observedAtMs: number; snapshot: HostWitnessSnapshot | null; qualified: false };
export type HostWitnessEvidence = { name: "host_capability_health"; schemaVersion: 1; eventId: string; at: string; installationId: string;
  sourceInstanceId: string; sourceSequence: number; observation: HostWitnessObservation };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
function data(v: unknown, keys: readonly string[]): Record<string, any> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k] || !("value" in ds[k]!))) return null;
  return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
}
function ids(v: unknown): v is string[] { return Array.isArray(v) && v.length <= 64 && v.every(s => typeof s === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(s)) && new Set(v).size === v.length; }
export function projectHostWitnessSnapshot(raw: unknown): HostWitnessSnapshot | null {
  const v = data(raw, ["version", "challenge", "sequence", "observedAtMs", "compilation", "capabilities", "events", "eventsDropped", "untrackedSlices", "coverage", "opportunityCoverage", "qualified", "leaseOpportunity"]);
  if (!v || v.version !== 2 || !uuid(v.challenge) || !integer(v.sequence, 1) || !integer(v.observedAtMs, 1) || !integer(v.eventsDropped)
    || v.coverage !== "registered-handles-and-recorded-boundaries" || !["not-observed", "managed-main-stream-entry"].includes(v.opportunityCoverage) || v.qualified !== false || !ids(v.untrackedSlices)
    || !Array.isArray(v.capabilities) || v.capabilities.length !== HOST_WITNESS_CAPABILITIES.length || !Array.isArray(v.events) || v.events.length > 32) return null;
  const compilation = projectHostCompileReceipt(v.compilation);
  if (!compilation || compilation.patch !== "applied" || compilation.nativeCompilation !== "returned" || Date.parse(compilation.at) > v.observedAtMs) return null;
  const capabilities: HostWitnessRow[] = [];
  for (let i = 0; i < v.capabilities.length; i++) {
    const r = data(v.capabilities[i], ["id", "required", "missingSlices", "handles"]);
    if (!r || r.id !== HOST_WITNESS_CAPABILITIES[i] || typeof r.required !== "boolean" || !ids(r.missingSlices)
      || HOST_WITNESS_REQUIRED[compilation.mode].includes(r.id) && r.required !== true
      || !["present", "absent", "changed", "not-required"].includes(r.handles) || (r.handles === "not-required") === r.required || !r.required && r.missingSlices.length) return null;
    capabilities.push(r as HostWitnessRow);
  }
  // The bounded ring is a contiguous suffix of one producer, not an arbitrary
  // selection of favourable observations. Missing events remain visible.
  if (v.sequence > 1_000_000_000 || v.eventsDropped > 1_000_000_000 - v.events.length
    || v.eventsDropped > 0 && v.events.length !== 32) return null;
  const events: HostWitnessEvent[] = []; let previous = v.eventsDropped, previousAt = Date.parse(compilation.at);
  for (const value of v.events) {
    const e = data(value, ["sequence", "atMs", "capability", "stage", "outcome", "correlation"]);
    if (!e || e.sequence !== previous + 1 || !integer(e.atMs, previousAt) || e.atMs > v.observedAtMs
      || !HOST_WITNESS_CAPABILITIES.includes(e.capability) || !HOST_WITNESS_STAGES.includes(e.stage)
      || !["observed", "returned", "threw"].includes(e.outcome) || !(e.correlation === null || hash(e.correlation))) return null;
    const allowed = e.capability === "session" ? ["session-enter", "native-selected", "managed-selected", "stream-enter", "terminal-consumed"]
      : e.capability === "retry" ? ["managed-failure-recognized"] : e.capability === "context" ? ["lease-open", "lease-close", "preflight-settled", "checkpoint-settled", "managed-stream-lease-present", "managed-stream-lease-missing"] : [];
    const outcomes = ["session-enter", "managed-selected", "stream-enter", "managed-failure-recognized", "lease-open", "managed-stream-lease-present", "managed-stream-lease-missing"].includes(e.stage)
      ? ["observed"] : ["native-selected", "lease-close"].includes(e.stage) ? ["returned"] : ["returned", "threw"];
    if (!allowed.includes(e.stage) || !outcomes.includes(e.outcome)) return null;
    if (isLeaseOpportunity(e as HostWitnessEvent) && (compilation.mode !== "route" || e.correlation === null)) return null;
    events.push(e as HostWitnessEvent); previous = e.sequence; previousAt = e.atMs;
  }
  const ledger = projectLeaseLedger(v.leaseOpportunity, compilation, v.observedAtMs, events, v.eventsDropped);
  if (!ledger || (v.opportunityCoverage === "managed-main-stream-entry") !== (ledger.observed > 0)) return null;
  return { ...v, compilation, capabilities, events, leaseOpportunity: ledger, untrackedSlices: [...v.untrackedSlices] } as HostWitnessSnapshot;
}
function projectLeaseLedger(raw: unknown, compilation: HostCompileReceipt, at: number, events: HostWitnessEvent[], dropped: number): HostLeaseOpportunityLedger | null {
  const v = data(raw, ["observed", "missing", "firstMissing", "last"]), total = dropped + events.length;
  if (!v || !integer(v.observed) || v.observed > total || !integer(v.missing) || v.missing > v.observed) return null;
  const entry = (value: unknown): HostWitnessEvent | null => {
    const e = data(value, ["sequence", "atMs", "capability", "stage", "outcome", "correlation"]);
    if (!e || !integer(e.sequence, 1) || e.sequence > total || !integer(e.atMs, Date.parse(compilation.at)) || e.atMs > at
      || !isLeaseOpportunity(e as HostWitnessEvent) || e.outcome !== "observed" || !hash(e.correlation)) return null;
    return e as HostWitnessEvent;
  };
  const firstMissing = v.firstMissing === null ? null : entry(v.firstMissing), last = v.last === null ? null : entry(v.last);
  if ((v.missing > 0) !== (firstMissing !== null) || (v.observed > 0) !== (last !== null)
    || v.firstMissing !== null && !firstMissing || v.last !== null && !last || v.observed > 0 && compilation.mode !== "route"
    || firstMissing && (firstMissing.stage !== "managed-stream-lease-missing" || !last || firstMissing.sequence > last.sequence || firstMissing.atMs > last.atMs)
    || last && (last.sequence < v.observed || last.stage === "managed-stream-lease-missing" && !firstMissing || last.stage === "managed-stream-lease-present" && v.observed === v.missing)) return null;
  const opportunities = events.filter(isLeaseOpportunity), missing = opportunities.filter(e => e.stage === "managed-stream-lease-missing");
  const omitted = v.observed - opportunities.length, missingOmitted = v.missing - missing.length;
  if (omitted < 0 || omitted > dropped || missingOmitted < 0 || missingOmitted > omitted) return null;
  const same = (a: HostWitnessEvent, b: HostWitnessEvent) => a.sequence === b.sequence && a.atMs === b.atMs && a.capability === b.capability && a.stage === b.stage && a.outcome === b.outcome && a.correlation === b.correlation;
  if (last && opportunities.length && !same(last, opportunities.at(-1)!)) return null;
  for (const e of [firstMissing, last]) if (e && e.sequence > dropped && !events.some(row => same(e, row))) return null;
  if (firstMissing && missing.length && (firstMissing.sequence > missing[0]!.sequence || missingOmitted === 0 && !same(firstMissing, missing[0]!))) return null;
  if (firstMissing && firstMissing.sequence <= dropped && missingOmitted === 0) return null;
  return { observed: v.observed, missing: v.missing, firstMissing, last };
}
export function projectHostWitnessObservation(raw: unknown): HostWitnessObservation | null {
  const v = data(raw, ["state", "reason", "observedAtMs", "snapshot", "qualified"]);
  if (!v || !["not-observed", "current", "unavailable", "invalid", "different-generation"].includes(v.state)
    || !["not-requested", "no-current-compilation", "unsupported-reader", "read-unavailable", "invalid-reply", "generation-changed", "matched"].includes(v.reason)
    || !integer(v.observedAtMs, 1) || v.qualified !== false) return null;
  const snapshot = v.snapshot === null ? null : projectHostWitnessSnapshot(v.snapshot);
  if ((v.state === "current") !== (snapshot !== null) || v.snapshot !== null && !snapshot || (v.reason === "matched") !== (v.state === "current")
    || snapshot && (snapshot.observedAtMs > v.observedAtMs || v.observedAtMs - snapshot.observedAtMs > 5000)) return null;
  return { ...v, snapshot } as HostWitnessObservation;
}
export function projectHostWitnessEvidence(raw: unknown): HostWitnessEvidence | null {
  const v = data(raw, ["name", "schemaVersion", "eventId", "at", "installationId", "sourceInstanceId", "sourceSequence", "observation"]);
  if (!v || v.name !== "host_capability_health" || v.schemaVersion !== 1 || !uuid(v.eventId) || !uuid(v.installationId) || !hash(v.sourceInstanceId)
    || !integer(v.sourceSequence) || typeof v.at !== "string" || v.at.length > 32 || !Number.isFinite(Date.parse(v.at))) return null;
  const observation = projectHostWitnessObservation(v.observation);
  return observation && observation.observedAtMs <= Date.parse(v.at) ? { ...v, observation } as HostWitnessEvidence : null;
}
/** Direct observation by the managed main-stream owner of the original lease
 * registry. This is not an expected/observed counter comparison, an execution
 * admission receipt, or proof of other unobserved opportunities. */
export function isLeaseOpportunity(e: Pick<HostWitnessEvent, "capability" | "stage">): boolean {
  return e.capability === "context" && (e.stage === "managed-stream-lease-present" || e.stage === "managed-stream-lease-missing");
}
export function hostLeaseOpportunityWindow(snapshot: HostWitnessSnapshot | null) {
  const events = snapshot?.events.filter(isLeaseOpportunity) ?? [];
  const present = events.filter(e => e.stage === "managed-stream-lease-present").length, missing = events.length - present;
  const retained = snapshot?.leaseOpportunity ?? null;
  return { present, missing, omitted: snapshot?.eventsDropped ?? 0, retained,
    state: retained && retained.missing > 0 ? "violated" as const
      : retained && retained.observed > 0 ? "observed" as const : "not-observed" as const };
}
export function hostLeaseOpportunityCondition(e: HostWitnessEvidence): "failed" | "passed" | "unknown" {
  if (e.observation.state !== "current") return "unknown";
  const window = hostLeaseOpportunityWindow(e.observation.snapshot);
  return window.state === "violated" ? "failed" : window.state === "observed" ? "passed" : "unknown";
}

export function hostWitnessDetectorCondition(e: HostWitnessEvidence): "failed" | "passed" | "unknown" {
  if (e.observation.state === "current") return "passed";
  return e.observation.state === "invalid" || e.observation.state === "unavailable" ? "failed" : "unknown";
}
export function hostWitnessCondition(e: HostWitnessEvidence): "failed" | "passed" | "unknown" {
  const s = e.observation.snapshot;
  if (e.observation.state !== "current" || !s) return "unknown";
  return s.capabilities.some(r => r.required && (r.missingSlices.length || r.handles !== "present")) ? "failed" : "passed";
}
