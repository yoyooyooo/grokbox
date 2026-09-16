import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMonitorSample, projectMonitorOwnershipDiagnosis } from "@grokbox/runtime-kernel/monitor";
import { OWNERSHIP_READ_SOURCE } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", base = 1767225600000;
const gateway = { pid: 42, startedAt: 1 };
function sample(offset: number, failed = false) {
  const now = base + offset;
  const snapshot = failed ? {
    ...ownedOwnershipSnapshot([agentId], { nowMs: now }), state: "unavailable", errorCode: "authorization_unavailable",
    scope: { id: "a".repeat(64), stable: false }, agents: [],
    readObservation: { version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "authorization_unavailable", phase: "server", rpcCode: 16, credential: "PRIVATE_SENTINEL" },
  } : ownedOwnershipSnapshot([agentId], { nowMs: now });
  return makeMonitorSample({ sampleId: randomUUID(), agentIds: [agentId], startedAtMs: now, completedAtMs: now + 1, response: { snapshot, gateway } });
}

test("monitor's failed ownership read is not relabelled scope failure; safe latest cause survives SQLite cold reads and resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-ownership-detail-")), store = openMonitorStore(root), epoch = randomUUID();
  try {
    await store.initialize(); await store.begin(epoch, base, [agentId]);
    await store.record(epoch, 1, sample(10));
    const failure = sample(20, true);
    expect(failure).toMatchObject({ failure: "read_unavailable", scopeId: null, readObservation: { errorCode: "authorization_unavailable", phase: "server", rpcCode: 16 } });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
    await store.record(epoch, 2, failure);
    const cold = openMonitorStore(root), before = await readFile(store.path);
    const incident = (await cold.incidents()).find(i => i.rule === "observation_unavailable")!;
    expect(incident).toMatchObject({ status: "open", diagnosis: { source: "monitor_ownership_read", observedAtMs: base + 21,
      failure: "read_unavailable", readObservation: { errorCode: "authorization_unavailable", rpcCode: 16 } } });
    expect((await cold.snapshot(base + 22)).agents[0]).toMatchObject({ lastKnown: { state: "confirmed_box" }, freshness: "unavailable" });
    expect(await readFile(store.path)).toEqual(before);
    const unknown = makeMonitorSample({ sampleId: randomUUID(), agentIds: [agentId], startedAtMs: base + 30, completedAtMs: base + 31 });
    await store.record(epoch, 3, unknown);
    const newer = (await cold.incidents()).find(i => i.id === incident.id)!;
    expect(newer).toMatchObject({ revision: incident.revision, diagnosis: { failure: "read_unavailable", observedAtMs: base + 31 } });
    expect(newer.diagnosis).not.toHaveProperty("readObservation");
    await store.record(epoch, 4, sample(40));
    expect((await cold.incidents()).find(i => i.id === incident.id)).toMatchObject({ status: "resolved", diagnosis: { observedAtMs: base + 31 } });
    expect((await cold.snapshot(base + 42)).agents[0]?.freshness).toBe("fresh");
    expect((await readFile(store.path)).includes(Buffer.from("PRIVATE_SENTINEL"))).toBe(false);
    await store.finish(epoch, base + 50);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collector diagnosis rejects coercion hooks and never gains execution identity or authority", () => {
  let calls = 0;
  const failure = { toString() { calls++; return "read_unavailable"; } };
  expect(projectMonitorOwnershipDiagnosis({ version: 1, source: "monitor_ownership_read", observedAtMs: base, failure })).toBeUndefined();
  expect(calls).toBe(0);
  const safe = projectMonitorOwnershipDiagnosis({ version: 1, source: "monitor_ownership_read", observedAtMs: base, failure: "read_unavailable", stepId: "PRIVATE_SENTINEL", admitted: true });
  expect(safe).toEqual({ version: 1, source: "monitor_ownership_read", observedAtMs: base, failure: "read_unavailable" });
});
