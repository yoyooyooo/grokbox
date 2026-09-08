import { describe, expect, test } from "bun:test";
import { parseRuntimeStartMode, prepareRuntimeStart, watchdogRequiredForStart } from "../src/internal/roots/command.runtime.ts";
import type { RuntimeStatus } from "../src/internal/io/observe.ts";

function fakeStatus(): RuntimeStatus {
  const observed = { source: "test", observedAt: null, gap: "missing" as const, value: null };
  return {
    schemaVersion: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    installation: { durableRoot: "/tmp/fake" },
    circuit: observed,
    facets: {
      bridge: { ...observed, value: { desired: "observe", actual: "unknown", origin: null, coverage: "unknown", reason: null } },
      modeld: { ...observed, value: { required: false, ready: null } },
      controller: { ...observed, value: { liveness: "unknown" } },
      mutation: { ...observed, value: { inhibited: false, allowed: false, reason: null } },
      recovery: { ...observed, value: { state: "unknown", pending: null } },
      hostDelivery: { ...observed, value: { kind: "not_observed", correlated: false, tuple: null } },
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
