import { expect, test } from "bun:test";
import { decideManagedOwnership, OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = { agentIds: [agentId], readLocal: () => ({ harness: "box", serverId: "server-1" }),
  readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
  readScope: () => ({ backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "fixture" }) };
const rows = { agents: [{ agentId, id: "server-1", harness: "box" }] };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function clock() {
  let time = 1000, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule: (callback: () => void, delayMs: number) => {
      const id = next++; timers.set(id, { at: time + delayMs, callback });
      return () => { timers.delete(id); };
    },
    advance: async (ms: number) => {
      time += ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]); due[1].callback(); await flush();
      }
      await flush();
    },
    pending: () => timers.size,
  };
}

test("native shared source has its own deadline; late waiter sees source timeout, not generic server failure", async () => {
  const c = clock();
  const read = bindHostOwnershipRead({ now: c.now, schedule: c.schedule, timeoutMs: 200 });
  let sourceSignal: AbortSignal | undefined, calls = 0;
  const ports = { ...base, listServer: (signal: AbortSignal) => {
    calls++; sourceSignal = signal;
    return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("PRIVATE_SENTINEL"), { code: 1 })), { once: true }));
  } };
  const first = read(ports); await flush();
  await c.advance(100);
  const later = read(ports); await flush();
  await c.advance(100);
  const [a, b] = await Promise.all([first, later]);
  expect(a).toMatchObject({ errorCode: "timeout" });
  expect(b.readObservation).toMatchObject({ errorCode: "timeout", serverRead: "shared", cancellationOrigin: "source_deadline", durationMs: 100 });
  expect(b.readObservation?.sourceReadId === a.readObservation?.sourceReadId).toBe(true);
  expect(calls).toBe(1);
  expect(sourceSignal?.aborted).toBe(true);
  expect(c.pending()).toBe(0);
  expect(JSON.stringify([a, b])).not.toContain("PRIVATE_SENTINEL");
});

test("external RPC cancellation retains unknown origin rather than pretending a local deadline", async () => {
  const read = bindHostOwnershipRead();
  const result = await read({ ...base, listServer: async () => { throw Object.assign(new Error("PRIVATE_SENTINEL"), { code: 1 }); } });
  expect(result.readObservation).toMatchObject({ errorCode: "source_cancelled", cancellationOrigin: "transport_unknown", rpcCode: 1 });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});

test("local-only mode never starts a Server read and never becomes registration permission", async () => {
  let reads = 0;
  const read = bindHostOwnershipRead();
  const result = await read({ ...base, localOnly: true, listServer: async () => { reads++; return rows; } });
  expect(reads).toBe(0);
  expect(result).toMatchObject({ source: OWNERSHIP_LOCAL_SOURCE });
  expect(result.readObservation).toBeUndefined();
  expect(decideManagedOwnership({ agentId, snapshot: result, nowMs: Date.now() }).ok).toBe(false);
});

test("native elapsed and original source age use the monotonic clock, not wall-clock jumps", async () => {
  let wall = 10_000, monotonic = 1000;
  const read = bindHostOwnershipRead({ now: () => wall, monotonicNow: () => monotonic });
  const result = await read({ ...base, listServer: async () => { wall += 50_000; monotonic += 50; return rows; } });
  expect(result.readObservation).toMatchObject({ durationMs: 50, serverEvidenceAgeMs: 50 });
  expect(result.observedAt).toBe(new Date(10_000).toISOString());
});

test("an invalid monotonic observation cannot authorize even with plausible wall timestamps", async () => {
  let monotonic = 1000;
  const read = bindHostOwnershipRead({ now: () => 10_000, monotonicNow: () => monotonic });
  const result = await read({ ...base, listServer: async () => { monotonic = 900; return rows; } });
  expect(result.state).toBe("unavailable");
  expect(result).toMatchObject({ errorCode: "clock_unavailable" });
  expect(result.agents[0]?.server).toBeNull();
  expect(decideManagedOwnership({ agentId, snapshot: result, nowMs: 10_000 }).ok).toBe(false);
});
