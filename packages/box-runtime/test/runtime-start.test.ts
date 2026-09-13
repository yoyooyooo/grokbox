import { expect, test } from "bun:test";
import { Effect } from "effect";
import { parseRuntimeStartMode, prepareRuntimeStart, watchdogRequiredForStart, type RuntimeStartInput, type RuntimeStartResult } from "../src/internal/roots/command.runtime.ts";
import type { RuntimeStatus } from "../src/internal/io/observe.ts";

// Pure command-program tests: every external capability is a fake. These do
// not open sockets, run the CLI or replace the separately required CLI lane.
function fakeStatus(): RuntimeStatus {
  const observed = { source: "fixture", observedAt: null, gap: "missing" as const, value: null };
  return { schemaVersion: 1, observedAt: "2026-01-01T00:00:00.000Z", installation: { durableRoot: "/owned" },
    circuit: observed, facets: {
      bridge: { ...observed, value: { desired: "observe", actual: "unknown", origin: null, coverage: "unknown", reason: null } },
      modeld: { ...observed, value: { required: false, ready: null } },
      controller: { ...observed, value: { liveness: "unknown" } },
      mutation: { ...observed, value: { inhibited: false, allowed: false, reason: null } },
      recovery: { ...observed, value: { state: "unknown", pending: null } },
      hostDelivery: { ...observed, value: { kind: "not_observed", correlated: false, tuple: null } },
    } };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
function fixture(kind: "owned" | "borrowed" = "borrowed") {
  const controller = new AbortController();
  const events: string[] = [];
  const receiptReady = barrier();
  let receipt: RuntimeStartResult | undefined;
  const input: RuntimeStartInput = {
    mode: "observe", signal: controller.signal,
    validate: Effect.sync(() => { events.push("validate"); }),
    startModeld: async signal => {
      expect(signal).toBe(controller.signal); events.push("acquire");
      return { ensure: kind === "owned" ? { kind, path: "/owned/modeld.sock", generation: "owned-generation" } : { kind, path: "/owned/modeld.sock" },
        finished: kind === "owned" ? new Promise<void>(() => {}) : Promise.resolve(),
        stop: async () => { events.push("stop"); } };
    },
    activate: async mode => { events.push(`save:${mode}`); return { configRevision: "a".repeat(64) }; },
    reconcile: async () => { events.push("reconcile"); return { outcome: "refused", reason: "confirmation-required", signaled: false, spawned: false, guardian: false, operationId: "owned-operation" }; },
    status: async () => { events.push("status"); return fakeStatus(); },
    publish: result => { events.push("publish"); receipt = result; receiptReady.release(); },
  };
  return { controller, events, input, receiptReady, receipt: () => receipt };
}

test("mode parsing and missing reconcile reject before validate/acquire/save", async () => {
  expect(() => parseRuntimeStartMode(undefined)).toThrow();
  expect(() => parseRuntimeStartMode("unsupported")).toThrow();
  expect(watchdogRequiredForStart("observe")).toBe(false);
  expect(watchdogRequiredForStart("route")).toBe(true);
  const f = fixture();
  await expect(prepareRuntimeStart({ ...f.input, mode: "identity", reconcile: undefined })).rejects.toThrow("unconfirmed reconciliation");
  expect(f.events).toEqual([]);
});

test("borrowed observe publishes configuration and observation but never stops/reconciles", async () => {
  const f = fixture();
  const receipt = await prepareRuntimeStart(f.input);
  expect(f.events).toEqual(["validate", "acquire", "save:observe", "status", "publish"]);
  expect(receipt).toMatchObject({ inject: false, reAdopt: false, productionAccepted: false,
    modeld: { kind: "borrowed", ready: true }, reconciliation: null,
    service: { lifetime: "borrowed", autostartInstalled: false } });
});

test("identity/route keeps a refused reconcile visible instead of declaring Host production ready", async () => {
  for (const mode of ["identity", "route"] as const) {
    const f = fixture();
    const receipt = await prepareRuntimeStart({ ...f.input, mode });
    expect(f.events).toEqual(["validate", "acquire", `save:${mode}`, "reconcile", "status", "publish"]);
    expect(receipt.reconciliation).toMatchObject({ outcome: "refused", signaled: false, spawned: false });
    expect(receipt.productionAccepted).toBe(false);
  }
});

for (const timing of ["after-publish", "inside-publish"] as const) {
  test(`owned service remains scoped through cancellation ${timing}`, async () => {
    const f = fixture("owned");
    if (timing === "inside-publish") {
      const publish = f.input.publish;
      f.input.publish = receipt => { publish(receipt); f.controller.abort(); };
    }
    let completed = false;
    const pending = prepareRuntimeStart(f.input).finally(() => { completed = true; });
    await f.receiptReady.wait;
    if (timing === "after-publish") {
      expect(completed).toBe(false);
      expect(f.events).not.toContain("stop");
      f.controller.abort();
    }
    const receipt = await pending;
    const observed = f.receipt();
    if (!observed) throw new Error("owned receipt was not published");
    expect(receipt).toBe(observed);
    expect(f.events.filter(event => event === "stop")).toHaveLength(1);
  });
}

for (const failed of ["validate", "acquire", "save", "reconcile", "status", "publish"] as const) {
  test(`failure at ${failed} preserves its cause and stops only the acquired owner`, async () => {
    const f = fixture("owned");
    const error = new Error(`owned-${failed}`);
    f.input.mode = "route";
    if (failed === "validate") f.input.validate = Effect.fail(error);
    if (failed === "acquire") f.input.startModeld = async () => { throw error; };
    if (failed === "save") f.input.activate = async () => { throw error; };
    if (failed === "reconcile") f.input.reconcile = async () => { throw error; };
    if (failed === "status") f.input.status = async () => { throw error; };
    if (failed === "publish") f.input.publish = () => { throw error; };
    await expect(prepareRuntimeStart(f.input)).rejects.toBe(error);
    expect(f.events.filter(event => event === "stop")).toHaveLength(["validate", "acquire"].includes(failed) ? 0 : 1);
    expect(f.events.filter(event => event.startsWith("save:"))).toHaveLength(["validate", "acquire", "save"].includes(failed) ? 0 : 1);
  });
}

test("pre-cancelled preparation has zero effects", async () => {
  const f = fixture("owned"); f.controller.abort();
  await expect(prepareRuntimeStart(f.input)).rejects.toThrow("runtime_start_cancelled");
  expect(f.events).toEqual([]);
});

test("cancellation cannot detach an in-progress configuration commit or invent a rollback", async () => {
  const f = fixture("owned"), writing = barrier(), finish = barrier();
  f.input.activate = async () => { f.events.push("write-begin"); writing.release(); await finish.wait; f.events.push("write-committed"); return { configRevision: "b".repeat(64) }; };
  const pending = prepareRuntimeStart(f.input);
  void pending.catch(() => {});
  await writing.wait;
  f.controller.abort();
  expect(f.events).not.toContain("stop");
  finish.release();
  await expect(pending).rejects.toThrow("runtime_start_cancelled");
  expect(f.events.slice(-2)).toEqual(["write-committed", "stop"]);
  expect(f.events).not.toContain("publish");
});

test("cancellation during acquire registers cleanup before returning and never saves intent", async () => {
  const f = fixture("owned"), acquiring = barrier(), releaseAcquire = barrier();
  f.input.startModeld = async () => {
    acquiring.release(); await releaseAcquire.wait;
    return { ensure: { kind: "owned", path: "/owned/modeld.sock", generation: "g" }, finished: new Promise<void>(() => {}), stop: async () => { f.events.push("stop"); } };
  };
  const pending = prepareRuntimeStart(f.input);
  void pending.catch(() => {});
  await acquiring.wait; f.controller.abort(); releaseAcquire.release();
  await expect(pending).rejects.toThrow("runtime_start_cancelled");
  expect(f.events).toEqual(["validate", "stop"]);
});

test("borrowed output failure never stops the external service", async () => {
  const f = fixture("borrowed");
  f.input.publish = () => { throw new Error("owned_output_failure"); };
  await expect(prepareRuntimeStart(f.input)).rejects.toThrow("owned_output_failure");
  expect(f.events).not.toContain("stop");
  expect(f.events).toContain("save:observe");
});

test("a published start observes later service failure and cleans up without waiting for a user signal", async () => {
  const f = fixture("owned");
  let fail!: (error: Error) => void;
  const finished = new Promise<void>((_, reject) => { fail = reject; });
  void finished.catch(() => undefined);
  const acquire = f.input.startModeld;
  f.input.startModeld = async signal => ({ ...await acquire(signal), finished });
  const pending = prepareRuntimeStart(f.input);
  await f.receiptReady.wait;
  const failure = new Error("owned_listener_failure"); fail(failure);
  await expect(pending).rejects.toBe(failure);
  expect(f.events.filter(event => event === "stop")).toHaveLength(1);
  expect(f.events.filter(event => event === "publish")).toHaveLength(1);
  expect(f.controller.signal.aborted).toBe(false);
});

test("an unexpectedly completed owned service cannot turn a ready receipt into successful command completion", async () => {
  const f = fixture("owned"), acquire = f.input.startModeld;
  f.input.startModeld = async signal => ({ ...await acquire(signal), finished: Promise.resolve() });
  await expect(prepareRuntimeStart(f.input)).rejects.toThrow("modeld_stopped_unexpectedly");
  expect(f.events.filter(event => event === "stop")).toHaveLength(1);
});

test("shutdown cleanup_gap is not swallowed as graceful cancellation", async () => {
  const f = fixture("owned");
  f.input.startModeld = async () => ({ ensure: { kind: "owned", path: "/owned/modeld.sock", generation: "g" }, finished: new Promise<void>(() => {}), stop: async () => { throw new Error("fixture-release-failed"); } });
  const pending = prepareRuntimeStart(f.input);
  await f.receiptReady.wait; f.controller.abort();
  await expect(pending).rejects.toThrow("cleanup_gap");
});
