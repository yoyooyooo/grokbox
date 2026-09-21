import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHostCapabilityWitness } from "../src/internal/host/capability-witness.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { bindHostCompactHook, isHostManagedRootActive, recordHostManagedStepFailure } from "../src/internal/host/compact.ts";
import { isHostManagedFailure } from "../src/internal/host/session.ts";
import { createHostContextControl, HOST_CONTEXT_CONTROL_SYMBOL } from "../src/internal/host/context-control.node.ts";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "../src/internal/host/ownership-read.ts";
import { createRunObserver, HOST_RUN_OBSERVATION_SYMBOL } from "../src/internal/host/run-observation.ts";
import { createAlertObserver, HOST_ALERT_OBSERVATION_SYMBOL } from "../src/internal/host/alert-observation.ts";
import { createServerActivityObserver, HOST_SERVER_ACTIVITY_SYMBOL } from "../src/internal/host/server-activity-observation.ts";
import { bindReceiverModel, HOST_RECEIVER_MODEL_SYMBOL } from "../src/internal/host/receiver-model.node.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { ROUTE_SESSION_SYMBOL, HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, HOST_MANAGED_FAILURE_SYMBOL, HOST_MANAGED_STEP_FAILURE_SYMBOL, HOST_RESUME_GATE_SYMBOL } from "../src/internal/host/profile.ts";
import { projectHostWitnessSnapshot, hostLeaseOpportunityWindow } from "@grokbox/runtime-kernel/host-health";

/** Inspect actual factory exports. A hand-authored set of fake method names
 * would repeat a typo in the registry and fail to detect the broken contract. */
function fixture() {
  const globals: Record<symbol, any> = {}, hash = "a".repeat(64), at = Date.now();
  const witness = createHostCapabilityWitness({ profileId: "owned-registry", sourceSha256: hash, transformedSourceSha256: hash, slices: LIVE_SLICE_PATCHES }, "route", globals);
  const install = (symbol: string, value: unknown) => { globals[Symbol.for(symbol)] = value; witness.register(symbol, value); };
  const options = { mode: "route" as const, durableRoot: "/fixture/not-read", runRoot: "/fixture/not-read" };
  install(ROUTE_SESSION_SYMBOL, bindHostSessionHook(options));
  install(HOST_COMPACT_SYMBOL, bindHostCompactHook());
  install(HOST_MANAGED_STEP_SYMBOL, isHostManagedRootActive);
  install(HOST_MANAGED_FAILURE_SYMBOL, isHostManagedFailure);
  install(HOST_MANAGED_STEP_FAILURE_SYMBOL, recordHostManagedStepFailure);
  install(HOST_CONTEXT_CONTROL_SYMBOL, createHostContextControl(options));
  install(HOST_OWNERSHIP_READ_SYMBOL, Object.assign(bindHostOwnershipRead(), { health: witness.read }));
  install(HOST_RESUME_GATE_SYMBOL, () => false);
  install(HOST_RUN_OBSERVATION_SYMBOL, createRunObserver({ generation: hash, emit: () => {} }));
  install(HOST_ALERT_OBSERVATION_SYMBOL, createAlertObserver({ generation: hash, emit: () => {} }));
  install(HOST_SERVER_ACTIVITY_SYMBOL, createServerActivityObserver({ generation: hash, instrumented: true }));
  install(HOST_RECEIVER_MODEL_SYMBOL, bindReceiverModel(options));
  witness.compiled({ version: 1, observationId: randomUUID(), at: new Date(at).toISOString(), pid: 1, start: 1, uid: 1000,
    operationDigest: hash, rootDigest: hash, targetDigest: hash, exeDigest: hash, argvDigest: hash, sourceSha: hash, candidateSha: hash, profileDigest: hash, preloadDigest: hash,
    mode: "route", patch: "applied", nativeCompilation: "returned", code: "compiled" });
  return { globals, witness, read: () => witness.read(randomUUID(), 1)! };
}

test("full route registration uses real factories including attachManager, not a matching fictional method table", () => {
  const f = fixture(), s = f.read();
  expect(projectHostWitnessSnapshot(s)).not.toBeNull();
  expect(s.capabilities.filter(c => c.required).map(c => [c.id, c.handles, c.missingSlices])).toEqual([
    ["session", "present", []], ["retry", "present", []], ["context", "present", []], ["ownership", "present", []],
    ["run-observer", "present", []], ["alert-observer", "present", []], ["server-activity", "present", []], ["receiver-model", "present", []],
  ]);
  expect(s.events).toHaveLength(0); expect(s.qualified).toBe(false); expect(s.opportunityCoverage).toBe("not-observed");
});

for (const [capability, symbol, method] of [
  ["alert-observer", HOST_ALERT_OBSERVATION_SYMBOL, "attachManager"], ["alert-observer", HOST_ALERT_OBSERVATION_SYMBOL, "decision"],
  ["alert-observer", HOST_ALERT_OBSERVATION_SYMBOL, "suppressed"], ["alert-observer", HOST_ALERT_OBSERVATION_SYMBOL, "withRemovalReason"],
  ["alert-observer", HOST_ALERT_OBSERVATION_SYMBOL, "removalReason"], ["run-observer", HOST_RUN_OBSERVATION_SYMBOL, "group"],
  ["run-observer", HOST_RUN_OBSERVATION_SYMBOL, "buffered"], ["run-observer", HOST_RUN_OBSERVATION_SYMBOL, "progress"],
  ["context", HOST_CONTEXT_CONTROL_SYMBOL, "wrapRun"], ["context", HOST_CONTEXT_CONTROL_SYMBOL, "manualOptions"],
] as const) test(`changing actual ${capability}.${method} is detected without calling it`, () => {
  const f = fixture(), object = f.globals[Symbol.for(symbol)], original = object[method]; let calls = 0;
  Object.defineProperty(object, method, { configurable: true, get: () => { calls++; return original; } });
  expect(f.read().capabilities.find(c => c.id === capability)!.handles).toBe("changed"); expect(calls).toBe(0);
  Object.defineProperty(object, method, { configurable: true, writable: true, value: original });
  expect(f.read().capabilities.find(c => c.id === capability)!.handles).toBe("present");
});

test("a missing lease cannot disappear before the first sample when the detailed ring rolls over", () => {
  const f = fixture(), tuple = { agentId: randomUUID(), turnId: randomUUID(), stepId: randomUUID() };
  f.witness.note({ ...tuple, capability: "context", stage: "managed-stream-lease-missing", outcome: "observed" });
  for (let i = 0; i < 64; i++) f.witness.note({ ...tuple, capability: "context", stage: "managed-stream-lease-present", outcome: "observed" });
  const sample = f.read();
  expect(sample.events).toHaveLength(32);
  expect(sample.events.every(e => e.stage === "managed-stream-lease-present")).toBe(true);
  expect(hostLeaseOpportunityWindow(sample).state).toBe("violated");
});

test("cumulative opportunities remain bounded, detached and consistent with the detailed suffix", () => {
  const f = fixture(), tuple = { agentId: randomUUID(), turnId: randomUUID(), stepId: randomUUID() };
  for (const stage of ["managed-stream-lease-present", "managed-stream-lease-missing", "managed-stream-lease-present"] as const)
    f.witness.note({ ...tuple, capability: "context", stage, outcome: "observed" });
  const s = f.read(), ledger = s.leaseOpportunity!;
  expect(s.version).toBe(2); expect(projectHostWitnessSnapshot(s)).not.toBeNull();
  expect(ledger).toMatchObject({ observed: 3, missing: 1, firstMissing: { sequence: 2 }, last: { sequence: 3 } });
  for (const patch of [{ observed: 2 }, { missing: 0, firstMissing: null }, { firstMissing: ledger.last }, { last: ledger.firstMissing }, { observed: 1e12 }, { privateBody: "private" }])
    expect(projectHostWitnessSnapshot({ ...s, leaseOpportunity: { ...ledger, ...patch } })).toBeNull();
  let calls = 0;
  const bad = { ...ledger }; Object.defineProperty(bad, "firstMissing", { enumerable: true, get() { calls++; return ledger.firstMissing; } });
  expect(projectHostWitnessSnapshot({ ...s, leaseOpportunity: bad })).toBeNull(); expect(calls).toBe(0);
  ledger.firstMissing!.correlation = "b".repeat(64); ledger.missing = 0;
  expect(f.read().leaseOpportunity!.missing).toBe(1); expect(f.read().leaseOpportunity!.firstMissing!.correlation).not.toBe("b".repeat(64));
});

test("retired window-only evidence is refused instead of supplying a compatibility read path", () => {
  const f = fixture(), { leaseOpportunity: _, ...base } = f.read();
  const old = { ...base, version: 1 as const };
  expect(projectHostWitnessSnapshot(old)).toBeNull();
  expect(projectHostWitnessSnapshot({ ...base, version: 2 })).toBeNull();
  expect(projectHostWitnessSnapshot({ ...old, leaseOpportunity: { observed: 0, missing: 0, firstMissing: null, last: null } })).toBeNull();
});

test("new metadata reads cannot clear the generation's first violated opportunity", () => {
  const f = fixture(), tuple = { agentId: randomUUID(), turnId: randomUUID(), stepId: randomUUID() };
  f.witness.note({ ...tuple, capability: "context", stage: "managed-stream-lease-missing", outcome: "observed" });
  const first = f.read().leaseOpportunity!.firstMissing;
  for (let i = 0; i < 100; i++) f.witness.note({ ...tuple, capability: "session", stage: "stream-enter", outcome: "observed" });
  const s = f.read();
  expect(s.events.some(e => e.capability === "context")).toBe(false);
  expect(s.opportunityCoverage).toBe("managed-main-stream-entry"); expect(projectHostWitnessSnapshot(s)).not.toBeNull();
  expect(s.leaseOpportunity!.firstMissing).toEqual(first); expect(hostLeaseOpportunityWindow(s).state).toBe("violated");
});

test("ownership resume gate remains a separate required original reference", () => {
  const f = fixture(); f.globals[Symbol.for(HOST_RESUME_GATE_SYMBOL)] = () => true;
  expect(f.read().capabilities.find(c => c.id === "ownership")!.handles).toBe("changed");
});
