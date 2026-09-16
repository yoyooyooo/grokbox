import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { StreamEvidence } from "@grokbox/runtime-kernel/contract";

const baseAt = Date.UTC(2026, 8, 16, 10), route = "b".repeat(64);
function row(offset: number, result: "ok" | number, options: { routeId?: string; agentId?: string; stepId?: string; turnId?: string } = {}) {
  const evidence = new StreamEvidence(); evidence.providerRoute({ id: options.routeId ?? route, api: "chat" });
  if (typeof result === "number") evidence.providerHttp({ status: result });
  return { name: "model_step_terminal", schemaVersion: 3, at: new Date(baseAt + offset).toISOString(),
    hostGenerationId: "a".repeat(64), serviceEpoch: "service", agentId: options.agentId ?? randomUUID(), turnId: options.turnId ?? randomUUID(), stepId: options.stepId ?? randomUUID(),
    outcome: result === "ok" ? "ok" : "error", phase: result === "ok" ? "complete" : "provider", eventCount: 0,
    ...(result === "ok" ? { stream: evidence.snapshot() } : { failureCode: "provider_error", diagnostic: { phase: "provider", reason: "http", httpStatus: result, stream: evidence.snapshot() } }) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "route-monitor-")), store = openMonitorStore(root), epoch = randomUUID();
  await store.initialize(); await store.begin(epoch, baseAt, [randomUUID()]); let cursor: string | null = null, n = 0;
  return { store,
    async push(events: unknown[]) { const nextCursor = String(++n); const receipt = await store.ingestEvidence({ epoch, sourceKey: "c".repeat(64), expectedCursor: cursor, nextCursor, events, atMs: baseAt + n }); cursor = nextCursor; return receipt; },
    async stop() { await store.finish(epoch, baseAt + 1000); await rm(root, { recursive: true, force: true }); },
  };
}

test("two Bots on the same route qualify one condition without erasing per-STEP occurrences", async () => {
  const f = await fixture();
  try {
    await f.push([row(1, 502)]); expect((await f.store.incidents()).filter(i => i.rule === "upstream_route_failure")).toHaveLength(0);
    await f.push([row(2, 503)]);
    const rows = await f.store.incidents(), condition = rows.find(i => i.rule === "upstream_route_failure")!;
    expect(condition.status).toBe("open"); expect(condition.diagnosis).toMatchObject({ kind: "provider_route_condition", routeId: route, state: "degraded", failures: 2 });
    expect(rows.filter(i => i.rule === "execution_failure")).toHaveLength(2);
    expect(rows.filter(i => i.rule === "execution_failure").every(i => i.parentIncidentId === condition.id)).toBe(true);
  } finally { await f.stop(); }
});
test("same model name on different route namespaces never qualifies a shared outage", async () => {
  const f = await fixture(); try { await f.push([row(1,502),row(2,503,{routeId:"d".repeat(64)})]); expect((await f.store.incidents()).some(i=>i.rule==="upstream_route_failure")).toBe(false); } finally { await f.stop(); }
});
test("a single success is not recovery; two subsequent complete STEPs are positive recovery evidence", async () => {
  const f = await fixture(); try {
    await f.push([row(1,502),row(2,503),row(3,"ok")]);
    expect((await f.store.incidents()).find(i=>i.rule==="upstream_route_failure")?.status).toBe("open");
    await f.push([row(4,"ok")]);
    const list = await f.store.incidents(); expect(list.find(i=>i.rule==="upstream_route_failure")?.status).toBe("resolved");
    expect(list.filter(i=>i.rule==="execution_failure").every(i=>i.status==="recorded")).toBe(true);
  } finally { await f.stop(); }
});
test("route outage survives source-window expiry and can recover on later positive observations", async () => {
  const f = await fixture(); try {
    await f.push([row(1,502),row(2,503)]); await f.push([row(600_001,"ok")]);
    expect((await f.store.incidents()).find(i=>i.rule==="upstream_route_failure")?.status).toBe("open");
    await f.push([row(600_002,"ok")]); expect((await f.store.incidents()).find(i=>i.rule==="upstream_route_failure")?.status).toBe("resolved");
  } finally { await f.stop(); }
});
test("new route failure cycle does not inherit acknowledgement or count earlier-cycle failures", async () => {
  const f = await fixture(); try {
    await f.push([row(1,502),row(2,503)]); const initial=(await f.store.incidents()).find(i=>i.rule==="upstream_route_failure")!;
    await f.store.manage({requestId:randomUUID(),incidentId:initial.id,expectedRevision:initial.revision,action:"ack",nowMs:baseAt+3});
    await f.push([row(4,"ok"),row(5,"ok")]); await f.push([row(6,503)]);
    expect((await f.store.incidents()).filter(i=>i.rule==="upstream_route_failure")).toHaveLength(1);
    await f.push([row(7,502)]); const conditions=(await f.store.incidents()).filter(i=>i.rule==="upstream_route_failure");
    expect(conditions).toHaveLength(2); expect(conditions.find(i=>i.status==="open")?.acknowledged).toBe(false);
    const late = row(2,503); await f.push([late]);
    const final = await f.store.incidents(); expect(final.filter(i=>i.rule==="upstream_route_failure")).toHaveLength(2);
    expect(final.find(i=>i.rule==="execution_failure" && i.agentId===late.agentId)?.parentIncidentId).toBe(initial.id);
  } finally { await f.stop(); }
});
test("arrival order with complete later success facts does not fabricate a new outage", async () => {
  const f = await fixture(); try {
    await f.push([row(4,"ok"),row(3,"ok"),row(2,503),row(1,502)]);
    expect((await f.store.incidents()).filter(i=>i.rule==="upstream_route_failure").map(i=>i.status)).toEqual(["resolved"]);
  } finally { await f.stop(); }
});
