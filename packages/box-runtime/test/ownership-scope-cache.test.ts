import { expect, test } from "bun:test";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const scope = { backend: "https://owned.invalid", account: "a".repeat(64), team: null, machine: "owned-machine-PRIVATE_SENTINEL" };
const row = (agentId: string) => ({ agentId, id: "owned-server", harness: "box", viewerIsOwner: true });
const readLocal = () => ({ serverId: "owned-server", harness: "box" });
const readWindow = () => ({ kind: "inactive" });
const readExecution = () => ({ allowed: true, bound: true });

test("single-flight scoped Server cache still rereads local identity and window on each call", async () => {
  let at = 10000, reads = 0, harness = "box";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = bindHostOwnershipRead({ cacheMs: 2000, now: () => at });
  const ports = { agentIds: [A], readScope: () => scope, readWindow, readExecution,
    readLocal: () => ({ serverId: "owned-server", harness }),
    listServer: async () => { reads++; await held; return { agents: [row(A), row(B)] }; } };
  const a = read(ports), b = read({ ...ports, agentIds: [B] });
  release();
  const first = await a, second = await b;
  expect(reads).toBe(1);
  expect(decideManagedOwnership({ agentId: A, snapshot: first, nowMs: at }).ok).toBe(true);
  expect(decideManagedOwnership({ agentId: B, snapshot: second, nowMs: at }).ok).toBe(true);
  expect(JSON.stringify(first)).not.toContain("PRIVATE_SENTINEL");
  at += 1000;
  harness = "temporal";
  const conflict = await read(ports);
  expect(reads).toBe(1);
  expect(decideManagedOwnership({ agentId: A, snapshot: conflict, nowMs: at })).toMatchObject({ ok: false, reason: "harness_mismatch" });
  at += 1001;
  await read(ports);
  expect(reads).toBe(2);
});

test("a slow native List does not renew old evidence freshness at response completion", async () => {
  let at = 10_000, reads = 0;
  const read = bindHostOwnershipRead({ cacheMs: 2000, now: () => at });
  const ports = { agentIds: [A], readScope: () => scope, readLocal, readWindow, readExecution,
    listServer: async () => {
      reads++;
      if (reads === 1) at += 6000; // The reply may describe state captured when the RPC began.
      return { agents: [row(A)] };
    } };
  const slow = await read(ports);
  expect(decideManagedOwnership({ agentId: A, snapshot: slow, nowMs: at }).ok).toBe(false);
  expect(slow).toMatchObject({ serverObservedAt: new Date(10_000).toISOString() });
  const refreshed = await read(ports);
  expect(reads).toBe(2); // A second caller cannot turn that late reply into a fresh cache hit.
  expect(decideManagedOwnership({ agentId: A, snapshot: refreshed, nowMs: at }).ok).toBe(true);
});

test("account/team/backend/machine changes cannot reuse the prior Server cache", async () => {
  let current: Record<string, unknown> = scope;
  let reads = 0;
  const read = bindHostOwnershipRead({ cacheMs: 2000 });
  const ports = { agentIds: [A], readScope: () => current, readLocal, readWindow, readExecution,
    listServer: async () => { reads++; return { agents: [row(A)] }; } };
  let previous: string | null | undefined;
  for (const changed of [scope, { ...scope, account: "b".repeat(64) }, { ...scope, team: 7 },
    { ...scope, backend: "https://another.invalid" }, { ...scope, machine: "different-machine" }]) {
    current = changed;
    const result = await read(ports);
    expect(result.state).toBe("observed");
    if (!("scope" in result)) throw Error("owned scoped read did not return scope evidence");
    expect(result.scope?.id).not.toBe(previous);
    previous = result.scope?.id;
  }
  expect(reads).toBe(5);
});

test("scope change while native List is in progress refuses the entire evidence", async () => {
  let account = "a".repeat(64);
  const result = await bindHostOwnershipRead({ cacheMs: 2000 })({ agentIds: [A], readLocal, readWindow, readExecution,
    readScope: () => ({ ...scope, account }),
    listServer: async () => { account = "b".repeat(64); return { agents: [row(A)] }; } });
  expect(result).toMatchObject({ state: "unavailable", errorCode: "scope_changed", scope: { stable: false } });
  expect(result.agents[0]?.server).toBeNull();
});

test("timeout of an uncooperative native reader does not create an unbounded background RPC pile", async () => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = bindHostOwnershipRead({ cacheMs: 2000, timeoutMs: 10 });
  const ports = { agentIds: [A], readLocal, readWindow, readExecution, readScope: () => scope,
    listServer: async () => { calls++; await held; return { agents: [row(A)] }; } };
  try {
    expect(await read(ports)).toMatchObject({ state: "unavailable", errorCode: "timeout" });
    for (let n = 0; n < 4; n++) expect(await read(ports)).toMatchObject({ state: "unavailable", errorCode: "busy" });
    expect(calls).toBe(1);
  } finally { release(); }
});

test("missing account scope and a moving migration window cannot authorize", async () => {
  let calls = 0;
  const missing = await bindHostOwnershipRead()({ agentIds: [A], readLocal, readWindow, readExecution, readScope: () => ({ ...scope, account: null }),
    listServer: async () => { calls++; return { agents: [row(A)] }; } });
  expect(missing).toMatchObject({ state: "unavailable", errorCode: "scope_unavailable" });
  expect(calls).toBe(0);
  let windowCalls = 0;
  const moving = await bindHostOwnershipRead()({ agentIds: [A], readLocal, readExecution, readScope: () => scope,
    readWindow: () => ++windowCalls === 1 ? { kind: "inactive" } : { kind: "active", status: "busy" },
    listServer: async () => ({ agents: [row(A)] }) });
  expect(decideManagedOwnership({ agentId: A, snapshot: moving, nowMs: Date.now() }).ok).toBe(false);
});
