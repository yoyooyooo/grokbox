import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { evidenceIdentity, observationIncidentCandidate, assessUnsettledExecution, STALL_POLICY,
  projectNativeRunHealth, NATIVE_RUN_HEALTH_MAX_AGE_MS, type NativeRunHealth } from "@grokbox/runtime-kernel/observation";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

type Input = { rootId: string; value: Record<string, unknown>; ref: string; at: number; sourceKey: string;
  opened: (id: string, agent: string | null) => Promise<void> };

/** Extra intake uses the same incidents/evidence domain, not another alert log. */
export async function indexNativeIncident(db: MonitorSqlite, input: Input) {
  const candidate = observationIncidentCandidate(input.value);
  if (!candidate) return;
  const agent = candidate.agentId && monitorUuid(candidate.agentId) ? candidate.agentId : null;
  const value = input.value;
  // A registered direct link can reuse the failure already indexed by its owner.
  // A parsed STEP in free-form alert text is deliberately insufficient.
  let linked = evidenceIdentity(value.failureId) && agent && evidenceIdentity(value.hostGenerationId)
    ? await db.first("SELECT i.* FROM incidents i JOIN incident_evidence l ON l.incident_id=i.id JOIN evidence e ON e.ref=l.event_ref WHERE i.scope=? AND e.agent_id=? AND e.host_generation=? AND e.failure_id=? ORDER BY i.first_seen LIMIT 1", [input.rootId, agent, value.hostGenerationId, value.failureId]) : null;
  if (!linked && value.stepEvidence === "direct" && evidenceIdentity(value.stepId) && agent && evidenceIdentity(value.hostGenerationId)) {
    linked = await db.first("SELECT i.* FROM incidents i JOIN incident_evidence l ON l.incident_id=i.id JOIN evidence e ON e.ref=l.event_ref WHERE i.scope=? AND e.agent_id=? AND e.host_generation=? AND e.step_id=? ORDER BY i.first_seen LIMIT 1", [input.rootId, agent, value.hostGenerationId, value.stepId]);
  }
  const key = sha256Text(canonicalJson(candidate.identity));
  linked ??= await db.first("SELECT * FROM incidents WHERE scope=? AND rule=? AND occurrence_key=?", [input.rootId, candidate.rule, key]);
  if (!linked) {
    const id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,?,?,'recorded',?,?,1,?,'occurrence',?)", [id, input.rootId, agent, candidate.rule, input.at, input.at, key, canonicalJson([value])]);
    await input.opened(id, agent); linked = { id };
  } else {
    await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?) WHERE id=?", [input.at, String(linked.id)]);
  }
  await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [String(linked.id), input.ref]);
}

export async function indexExecutionProgress(db: MonitorSqlite, input: Input) {
  const v = input.value;
  if (v.name !== "host_run_observation" || !monitorUuid(v.agentId) || !evidenceIdentity(v.hostGenerationId) || !evidenceIdentity(v.dispatchId)
    || !["queued", "started", "finished", "failed", "cancelled"].includes(String(v.state))) return;
  const identity = sha256Text(canonicalJson([v.hostGenerationId, v.agentId, v.dispatchId]));
  const previous = await db.first("SELECT state,last_progress FROM open_executions WHERE identity=?", [identity]);
  if (previous && (!["queued", "started"].includes(String(previous.state)) || Number(previous.last_progress) > input.at)) return;
  if (!previous) {
    const count = Number((await db.first("SELECT COUNT(*) AS n FROM open_executions WHERE state IN ('queued','started')"))?.n ?? 0);
    if (count >= STALL_POLICY.maxOpen && ["queued", "started"].includes(String(v.state))) {
      await recordSourceGap(db, { ...input, reason: "open_execution_capacity" }); return;
    }
  }
  await db.run("INSERT INTO open_executions(identity,source_key,agent_id,host_generation,dispatch_id,state,last_progress,event_ref) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET state=excluded.state,last_progress=excluded.last_progress,event_ref=excluded.event_ref", [identity, input.sourceKey, v.agentId, v.hostGenerationId, v.dispatchId, String(v.state), input.at, input.ref]);
  if (!["queued", "started"].includes(String(v.state))) {
    const prior = await db.first("SELECT incident_id FROM open_executions WHERE identity=?", [identity]);
    if (prior?.incident_id) await db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=?,revision=revision+1 WHERE id=? AND status='open'", [input.at, input.at, String(prior.incident_id)]);
  }
}

const GAP_REASONS = ["unavailable", "missing", "retention", "rotated", "truncated", "malformed_line", "unsupported_schema", "source_conflict", "storage_pressure", "open_execution_capacity"] as const;
export async function recordSourceGap(db: MonitorSqlite, input: Pick<Input, "rootId" | "sourceKey" | "at" | "opened"> & { reason: string }) {
  const key = sha256Text(canonicalJson(["source-gap", input.sourceKey]));
  const reason = GAP_REASONS.find(code => input.reason.includes(code)) ?? "unavailable";
  let row = await db.first("SELECT id FROM incidents WHERE scope=? AND rule='source_gap' AND occurrence_key=? AND status='open'", [input.rootId, key]);
  if (!row) {
    const id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,'source_gap','open',?,?,1,?,'condition',?)", [id, input.rootId, input.at, input.at, key, canonicalJson({ reason, source: "observation" })]);
    await input.opened(id, null); row = { id };
  } else await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?),summary_json=? WHERE id=?", [input.at, canonicalJson({ reason, source: "observation" }), String(row.id)]);
}

/** Callers must supply actual source-liveness evidence. Reading an unchanged log
 * file or an unrelated Bot heartbeat is not sufficient to diagnose a stall. */
export async function detectUnsettledExecutions(db: MonitorSqlite, input: { rootId: string; nowMs: number;
  sourceLiveness: ReadonlyMap<string, number>; nativeRuns?: NativeRunHealth; opened: Input["opened"] }) {
  const rows = await db.all("SELECT * FROM open_executions WHERE state IN ('queued','started') AND last_progress<=? ORDER BY last_progress LIMIT 100", [input.nowMs - STALL_POLICY.minIdleMs]);
  let suspected = 0, unqualified = 0;
  const native = projectNativeRunHealth(input.nativeRuns);
  for (const row of rows) {
    let progressMs = Number(row.last_progress), sourceLastObservedMs = input.sourceLiveness.get(String(row.source_key)) ?? null;
    if (input.nativeRuns !== undefined) {
      if (!native || native.coverage !== "observed_window" || native.droppedTasks !== 0 || input.nowMs < native.observedAtMs
        || input.nowMs - native.observedAtMs > NATIVE_RUN_HEALTH_MAX_AGE_MS || native.hostGenerationId !== row.host_generation) { unqualified++; continue; }
      const task = native.tasks.find(task => task.agentId === row.agent_id && task.dispatchId === row.dispatch_id);
      // A queue backlog, tool/approval wait or absent task is not a deadlock.
      // In particular, missing terminal evidence does not prove completion.
      if (!task || task.state !== "started" || task.phase === "tool_or_approval") { unqualified++; continue; }
      progressMs = Math.max(progressMs, task.lastProgressMs); sourceLastObservedMs = native.observedAtMs;
    }
    const result = assessUnsettledExecution({ state: String(row.state), nowMs: input.nowMs, lastProgressMs: progressMs, sourceLastObservedMs });
    if (result === "source_unavailable") { unqualified++; continue; }
    if (result !== "suspected" || row.incident_id) continue;
    const id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category) VALUES(?,?,?,'execution_stalled','open',?,?,1,?,'condition')", [id, input.rootId, String(row.agent_id), input.nowMs, input.nowMs, String(row.identity)]);
    await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [id, String(row.event_ref)]);
    if (native) {
      // Only a newly opened incident retains this exact source-owned window;
      // periodic reads never append a lifetime-sized stream of heartbeats.
      const witness = { ...native, name: "host_run_health", at: new Date(native.observedAtMs).toISOString() };
      const payload = canonicalJson(witness), hash = sha256Text(payload), ref = `native-run-health:${hash}`;
      await db.run("INSERT OR IGNORE INTO evidence(ref,digest,source_key,at_ms,host_generation,payload) VALUES(?,?,?,?,?,?)",
        [ref, hash, String(row.source_key), native.observedAtMs, native.hostGenerationId, payload]);
      await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [id, ref]);
    }
    await db.run("UPDATE open_executions SET incident_id=? WHERE identity=?", [id, String(row.identity)]);
    await input.opened(id, String(row.agent_id)); suspected++;
  }
  return { suspected, unqualified, inference: "suspected_not_confirmed_deadlock" };
}
