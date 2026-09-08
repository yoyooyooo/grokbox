import { describe, expect, test } from "bun:test";
import { parseRuntimeStartMode, prepareRuntimeStart, watchdogRequiredForStart } from "../src/internal/roots/command.runtime.ts";
import type { RuntimeStatus } from "../src/internal/io/observe.ts";

function fakeStatus(): RuntimeStatus {
  return {
    installation: { durableRoot: "/tmp/fake", cliInstallRootUnused: true },
    activation: { desired: "observe", actual: "unknown", reconcile: "unknown", reason: null },
    host: { diskSha: null, origin: "official", reason: null, topology: "unknown" },
    coverage: "none",
    census: { wrapper: null, supervisor: null, host: null },
    circuit: "unknown",
    coordinator: { state: "not_observed", mutationCount: null, lastAttemptKey: null, circuitReason: null },
    operation: { state: "not_observed", phase: null, pending: null },
    lastHeal: null,
    driftedSlices: null,
    contracts: { state: "not_observed", head: null, sourceSha: null, diskMatchesHead: null },
    bundles: { state: "not_observed", head: null, retained: null, liveRetained: null, lastMatchedSha: null },
    watchdog: { required: false, state: "unknown" },
    modeld: { required: false, state: "unknown" },
    models: { main: null, agents: {}, assignmentState: "unknown" },
    window: { durationMs: null, affectedInvocations: "unknown" },
    evidence: {
      desired: "not_observed", models: "not_observed", source: "not_observed", processes: "not_observed",
      gateway: "not_observed", attestation: "not_observed", profile: "not_observed", events: "not_observed",
    },
  };
}

describe("prepareRuntimeStart", () => {
  test("rejects missing or invalid mode", () => {
    expect(() => parseRuntimeStartMode(undefined)).toThrow(/observe, identity, or route/);
    expect(() => parseRuntimeStartMode("canary")).toThrow(/observe, identity, or route/);
    expect(parseRuntimeStartMode("observe")).toBe("observe");
    expect(watchdogRequiredForStart("observe")).toBe(false);
    expect(watchdogRequiredForStart("identity")).toBe(true);
    expect(watchdogRequiredForStart("route")).toBe(true);
  });

  test("reuses a live modeld, writes desired, skips watchdog on observe, never re-adopts", async () => {
    const calls: string[] = [];
    const result = await prepareRuntimeStart({
      mode: "observe",
      probeModeld: async () => true,
      startModeld: async () => { calls.push("start"); },
      activate: async (mode) => { calls.push(`activate:${mode}`); },
      tickWatchdog: async () => {
        calls.push("watchdog");
        return { watchdogState: "idle", reconcile: "unknown", reason: null, circuit: "closed" };
      },
      status: async () => fakeStatus(),
    });
    expect(calls).toEqual(["activate:observe"]);
    expect(result).toMatchObject({
      process: "start", desired: "observe", inject: false, reAdopt: false,
      modeld: { ready: true, started: false, alreadyRunning: true },
      watchdog: { ran: false },
    });
  });

  test("starts modeld when down and ticks watchdog for identity", async () => {
    let up = false;
    const calls: string[] = [];
    const result = await prepareRuntimeStart({
      mode: "identity",
      probeModeld: async () => up,
      startModeld: async () => { calls.push("start"); up = true; },
      activate: async (mode) => { calls.push(`activate:${mode}`); },
      tickWatchdog: async () => {
        calls.push("watchdog");
        return { watchdogState: "idle", reconcile: "unknown", reason: null, circuit: "closed" };
      },
      status: async () => fakeStatus(),
    });
    expect(calls).toEqual(["start", "activate:identity", "watchdog"]);
    expect(result.modeld).toEqual({ ready: true, started: true, alreadyRunning: false });
    expect(result.watchdog).toMatchObject({ ran: true, state: "idle", reconcile: "unknown" });
    expect(result.reAdopt).toBe(false);
    expect(result.inject).toBe(false);
  });

  test("treats a competitor socket as already-running after re-probe", async () => {
    let probes = 0;
    const result = await prepareRuntimeStart({
      mode: "observe",
      probeModeld: async () => {
        probes += 1;
        return probes >= 2;
      },
      startModeld: async () => {
        throw new Error("modeld socket is owned by a live competitor.");
      },
      activate: async () => undefined,
      tickWatchdog: async () => {
        throw new Error("observe must not tick watchdog");
      },
      status: async () => fakeStatus(),
    });
    expect(result.modeld).toEqual({ ready: true, started: false, alreadyRunning: true });
    expect(result.reAdopt).toBe(false);
  });

  test("does not activate when modeld stays down", async () => {
    const calls: string[] = [];
    await expect(prepareRuntimeStart({
      mode: "observe",
      probeModeld: async () => false,
      startModeld: async () => { calls.push("start"); },
      activate: async () => { calls.push("activate"); },
      status: async () => fakeStatus(),
    })).rejects.toThrow(/did not become ready/);
    expect(calls).toEqual(["start"]);
  });

  test("propagates start failure when probe stays down", async () => {
    const calls: string[] = [];
    await expect(prepareRuntimeStart({
      mode: "observe",
      probeModeld: async () => false,
      startModeld: async () => { throw new Error("boom"); },
      activate: async () => { calls.push("activate"); },
      status: async () => fakeStatus(),
    })).rejects.toThrow(/boom/);
    expect(calls).toEqual([]);
  });

  test("identity without a watchdog tick port is invalid_usage", async () => {
    await expect(prepareRuntimeStart({
      mode: "identity",
      probeModeld: async () => true,
      startModeld: async () => undefined,
      activate: async () => undefined,
      status: async () => fakeStatus(),
    })).rejects.toThrow(/watchdog tick/);
  });
});
