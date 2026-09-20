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
import { projectHostWitnessSnapshot } from "@grokbox/runtime-kernel/host-health";

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

test("ownership resume gate remains a separate required original reference", () => {
  const f = fixture(); f.globals[Symbol.for(HOST_RESUME_GATE_SYMBOL)] = () => true;
  expect(f.read().capabilities.find(c => c.id === "ownership")!.handles).toBe("changed");
});
