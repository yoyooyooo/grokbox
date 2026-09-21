import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_WITNESS_CAPABILITIES, HOST_WITNESS_REQUIRED, isLeaseOpportunity, type HostCompileReceipt, type HostWitnessCapability, type HostWitnessNote, type HostWitnessEvent, type HostWitnessSnapshot, type HostLeaseOpportunityLedger } from "@grokbox/runtime-kernel/host-health";
import { REQUIRED_SLICE_IDS, CONTEXT_SLICE_IDS, NATIVE_CHECKPOINT_SLICE_IDS, NATIVE_CURRENT_STATE_SLICE_IDS, ROUTE_SESSION_SYMBOL, HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, HOST_MANAGED_FAILURE_SYMBOL, HOST_MANAGED_STEP_FAILURE_SYMBOL, HOST_RESUME_GATE_SYMBOL, type PatchProfile } from "./profile.ts";
import { HOST_OWNERSHIP_READ_SYMBOL } from "./ownership-read.ts";
import { HOST_CONTEXT_CONTROL_SYMBOL } from "./context-control.node.ts";
import { HOST_RUN_OBSERVATION_SYMBOL } from "./run-observation.ts";
import { HOST_ALERT_OBSERVATION_SYMBOL } from "./alert-observation.ts";
import { HOST_SERVER_ACTIVITY_SYMBOL } from "./server-activity-observation.ts";
import { HOST_RECEIVER_MODEL_SYMBOL } from "./receiver-model.node.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "./native-current-state-owner.ts";

type Handle = readonly [symbol: string, method?: string];
const registry: Record<HostWitnessCapability, { slices: readonly string[]; handles: readonly Handle[]; defaultMode: "both" | "route" | "selected" }> = {
  session: { slices: REQUIRED_SLICE_IDS, handles: [[ROUTE_SESSION_SYMBOL]], defaultMode: "both" },
  retry: { slices: ["managed-retry-gate", "managed-turn-retry-gate", "managed-step-error-scope", "managed-output-retry-gate", "managed-summary-retry-gate"],
    handles: [[HOST_MANAGED_FAILURE_SYMBOL], [HOST_MANAGED_STEP_FAILURE_SYMBOL]], defaultMode: "route" },
  context: { slices: ["compact-register", "compact-background-start", "compact-background-response", ...CONTEXT_SLICE_IDS],
    handles: [[HOST_COMPACT_SYMBOL], [HOST_MANAGED_STEP_SYMBOL], [HOST_CONTEXT_CONTROL_SYMBOL, "call"], [HOST_CONTEXT_CONTROL_SYMBOL, "manualAction"], [HOST_CONTEXT_CONTROL_SYMBOL, "manualOptions"], [HOST_CONTEXT_CONTROL_SYMBOL, "wrapRun"]], defaultMode: "route" },
  ownership: { slices: ["ownership-read-schema", "ownership-read-api", "ownership-resume-gate"],
    handles: [[HOST_OWNERSHIP_READ_SYMBOL], [HOST_OWNERSHIP_READ_SYMBOL, "capabilities"], [HOST_OWNERSHIP_READ_SYMBOL, "health"], [HOST_RESUME_GATE_SYMBOL]], defaultMode: "both" },
  "run-observer": { slices: ["run-queue-observation", "tool-execution-observation", "tool-execution-failure-observation", "group-member-observation", "group-buffer-observation"],
    handles: [[HOST_RUN_OBSERVATION_SYMBOL, "queue"], [HOST_RUN_OBSERVATION_SYMBOL, "tool"], [HOST_RUN_OBSERVATION_SYMBOL, "snapshot"], [HOST_RUN_OBSERVATION_SYMBOL, "group"], [HOST_RUN_OBSERVATION_SYMBOL, "buffered"], [HOST_RUN_OBSERVATION_SYMBOL, "current"], [HOST_RUN_OBSERVATION_SYMBOL, "progress"]], defaultMode: "route" },
  "alert-observer": { slices: ["alert-manager-observation", "alert-main-decision", "alert-input-cleanup", "alert-automation-decision", "alert-automation-throttle"],
    handles: [[HOST_ALERT_OBSERVATION_SYMBOL, "attachManager"], [HOST_ALERT_OBSERVATION_SYMBOL, "decision"], [HOST_ALERT_OBSERVATION_SYMBOL, "suppressed"], [HOST_ALERT_OBSERVATION_SYMBOL, "withRemovalReason"], [HOST_ALERT_OBSERVATION_SYMBOL, "removalReason"]], defaultMode: "route" },
  "server-activity": { slices: ["server-activity-live-observation", "server-activity-expiry-observation"],
    handles: [[HOST_SERVER_ACTIVITY_SYMBOL, "snapshot"]], defaultMode: "selected" },
  "receiver-model": { slices: ["receiver-native-model-preview"], handles: [[HOST_RECEIVER_MODEL_SYMBOL, "read"]], defaultMode: "selected" },
  continuity: { slices: [...NATIVE_CHECKPOINT_SLICE_IDS, ...NATIVE_CURRENT_STATE_SLICE_IDS], handles: [[NATIVE_CURRENT_STATE_SYMBOL, "call"], [NATIVE_CURRENT_STATE_SYMBOL, "register"]], defaultMode: "selected" },
};
const own = (o: unknown, key: PropertyKey): unknown => {
  if ((!o || typeof o !== "object") && typeof o !== "function") return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key); return d && "value" in d ? d.value : undefined;
};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x1f]/.test(v);

/** Bounded in-memory metadata. No timer, IO, RPC, model, root writer or generic
 * wrapper of business functions. Samples inspect original object identities;
 * recording failures must never change native return values or exceptions. */
export function createHostCapabilityWitness(profile: PatchProfile, mode: "identity" | "route", globals: object = globalThis, now: () => number = Date.now) {
  const selected = new Set(profile.slices.map(s => s.id));
  const tracked = new Map<string, { value: unknown; methods: Map<string, unknown> }>();
  let compilation: HostCompileReceipt | null = null, sequence = 0, eventSequence = 0, dropped = 0;
  const events: HostWitnessEvent[] = [];
  const leaseOpportunity: HostLeaseOpportunityLedger = { observed: 0, missing: 0, firstMissing: null, last: null };
  function register(symbol: string, value: unknown) {
    // Called at actual assignment, never by discovering whichever later value
    // happens to occupy the slot. Rebinding cannot become the new expected one.
    if (tracked.has(symbol)) return;
    const methods = new Map<string, unknown>();
    for (const definition of Object.values(registry)) for (const [s, method] of definition.handles) if (s === symbol && method) methods.set(method, own(value, method));
    tracked.set(symbol, { value, methods });
  }
  function note(input: HostWitnessNote) {
    try {
      if (!compilation || compilation.patch !== "applied" || compilation.nativeCompilation !== "returned" || eventSequence >= 1_000_000_000) return;
      const at = now(); if (at < Date.parse(compilation.at)) return;
      const tuple = [input.agentId, input.turnId, input.stepId];
      const correlation = tuple.slice(0, 2).every(id) && (tuple[2] === undefined || id(tuple[2])) ? sha256Text(canonicalJson(tuple.map(v => v ?? null))) : null;
      if (isLeaseOpportunity(input) && (mode !== "route" || correlation === null || !id(input.stepId))) return;
      const event: HostWitnessEvent = { sequence: ++eventSequence, atMs: at, capability: input.capability, stage: input.stage, outcome: input.outcome, correlation };
      events.push(event);
      if (isLeaseOpportunity(event)) {
        leaseOpportunity.observed++;
        if (event.stage === "managed-stream-lease-missing") { leaseOpportunity.missing++; leaseOpportunity.firstMissing ??= { ...event }; }
        leaseOpportunity.last = { ...event };
      }
      if (events.length > 32) { events.shift(); dropped++; }
    } catch { /* Observation never owns business outcomes. */ }
  }
  function read(challenge: unknown, wrapperVersion: unknown): HostWitnessSnapshot | null {
    if (wrapperVersion !== 1 || typeof challenge !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(challenge)
      || !compilation || compilation.patch !== "applied" || compilation.nativeCompilation !== "returned" || sequence >= 1_000_000_000) return null;
    const at = now(); if (at < Date.parse(compilation.at) || events.some(e => e.atMs > at)) return null;
    const covered = new Set(Object.values(registry).flatMap(r => [...r.slices]));
    return { version: 2, challenge, sequence: ++sequence, observedAtMs: at, compilation: { ...compilation },
      capabilities: HOST_WITNESS_CAPABILITIES.map(id => {
        const d = registry[id], required = HOST_WITNESS_REQUIRED[mode].includes(id) || d.defaultMode === "selected" && d.slices.some(s => selected.has(s as never));
        let handles: "present" | "absent" | "changed" | "not-required" = required ? "present" : "not-required";
        if (required) for (const [symbol, method] of d.handles) {
          const expected = tracked.get(symbol), actual = own(globals, Symbol.for(symbol));
          if (!expected || expected.value === undefined || method && typeof expected.methods.get(method) !== "function" || !method && typeof expected.value !== "function") { handles = "absent"; break; }
          if (actual !== expected.value || method && own(actual, method) !== expected.methods.get(method)) { handles = "changed"; break; }
        }
        return { id, required, handles, missingSlices: required ? d.slices.filter(s => !selected.has(s as never)) : [] };
      }), events: events.map(e => ({ ...e })), eventsDropped: dropped, untrackedSlices: [...selected].filter(s => !covered.has(s)),
      leaseOpportunity: { ...leaseOpportunity, firstMissing: leaseOpportunity.firstMissing && { ...leaseOpportunity.firstMissing }, last: leaseOpportunity.last && { ...leaseOpportunity.last } },
      coverage: "registered-handles-and-recorded-boundaries", opportunityCoverage: leaseOpportunity.observed > 0 ? "managed-main-stream-entry" : "not-observed", qualified: false };
  }
  return { register, note, read, compiled: (receipt: HostCompileReceipt) => { if (!compilation) compilation = Object.freeze({ ...receipt }); } };
}
