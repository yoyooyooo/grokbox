import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { observationId, diagnoseExecution, safeAlertCode, ALERT_DIAGNOSIS_VERSION } from "@grokbox/runtime-kernel/alerts";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { projectControlEvent } from "./journal.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

function summaryFacts(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 3) return [];
    return parsed.map(projectControlEvent).filter((v): v is NonNullable<typeof v> => v !== null) as Record<string, unknown>[];
  } catch { return []; }
}
/** Small safe occurrence facts survive eviction of high-volume raw evidence.
 * They do not turn a historical failure into success when a service recovers. */
export function retainedDiagnosis(value: unknown) {
  const facts = summaryFacts(value), first = facts[0];
  if (!first || !observationId(first.agentId)) return null;
  if (!observationId(first.stepId)) return first.name === "host_stream_rejected"
    ? { state: "failure_observed", scope: "operation_not_step", code: safeAlertCode(first.errorCode) ?? "other",
        source: first.name, stage: first.stage ?? null, classifierVersion: ALERT_DIAGNOSIS_VERSION, stepId: null,
        dispatchId: observationId(first.dispatchId) ? first.dispatchId : null, toolExecution: "not_observed" }
    : null;
  return diagnoseExecution(facts, { agentId: first.agentId, stepId: first.stepId,
    ...(observationId(first.hostGenerationId) ? { hostGenerationId: first.hostGenerationId } : {}) });
}

export async function indexExecutionOccurrence(db: MonitorSqlite, input: {
  rootId: string; epoch: string; value: Record<string, unknown>; ref: string; at: number;
  opened: (incidentId: string, agentId: string | null) => Promise<void>;
  recovered: (incidentId: string) => Promise<void>;
}): Promise<void> {
  const { value, rootId, ref, at, opened } = input;
  if (!monitorUuid(value.agentId)) return;
  if (!observationId(value.stepId) || !observationId(value.turnId)) {
    if (value.name !== "host_stream_rejected") return;
    const operation = observationId(value.failureId) ? value.failureId : observationId(value.dispatchId) ? value.dispatchId : ref;
    const key = sha256Text(canonicalJson([value.hostGenerationId ?? null, value.agentId, operation, value.errorCode]));
    let row = await db.first("SELECT id FROM incidents WHERE scope=? AND agent_id=? AND rule='pre_step_failure' AND occurrence_key=?", [rootId, value.agentId, key]);
    if (!row) { const id = randomUUID(); await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,?,'pre_step_failure','recorded',?,?,1,?,'occurrence',?)", [id, rootId, value.agentId, at, at, key, canonicalJson([value])]); await opened(id, value.agentId); row = { id }; }
    await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [String(row.id), ref]);
    return;
  }
  // Only fresh, same-service, positive admission/storage evidence can close the
  // current shared condition. A disappeared Tray or an unrelated Bot's success
  // on another service cannot repair a historical execution failure.
  const execution = value.execution as { accepting?: unknown; history?: { available?: unknown } } | undefined;
  if (value.name === "model_step_terminal" && value.outcome === "ok" && value.phase === "complete"
    && observationId(value.serviceEpoch) && execution?.accepting === true && execution.history?.available === true) {
    for (const code of ["capacity", "ledger_unavailable"]) {
      const occurrence = sha256Text(canonicalJson(["service", value.serviceEpoch, code]));
      const parents = await db.all("SELECT id FROM incidents WHERE scope=? AND rule='shared_runtime_failure' AND occurrence_key=? AND status='open' AND last_seen<?", [rootId, occurrence, at]);
      for (const parent of parents) {
        await db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=?,revision=revision+1 WHERE id=?", [at, at, String(parent.id)]);
        await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [String(parent.id), ref]);
        await input.recovered(String(parent.id));
      }
    }
    return;
  }
  const isFailure = value.name === "host_stream_rejected"
    || (value.name === "host_normalized_terminal" && ["error", "abort"].includes(String(value.terminalClass)))
    || (value.name === "model_step_terminal" && ["error", "cancelled"].includes(String(value.outcome)));
  if (!isFailure) return;
  const generation = observationId(value.hostGenerationId) ? value.hostGenerationId : null;
  const key = sha256Text(canonicalJson([generation, value.agentId, value.turnId, value.stepId]));
  let child = await db.first("SELECT * FROM incidents WHERE scope=? AND agent_id=? AND rule='execution_failure' AND occurrence_key=?", [rootId, value.agentId, key]);
  if (!child) {
    const id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,?,'execution_failure','recorded',?,?,1,?,'occurrence',?)", [id, rootId, value.agentId, at, at, key, canonicalJson([value])]);
    await opened(id, value.agentId);
    child = await db.first("SELECT * FROM incidents WHERE id=?", [id]);
  } else {
    const byLayer = new Map(summaryFacts(child.summary_json).map(v => [v.name, v]));
    byLayer.set(value.name, value);
    await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?),summary_json=? WHERE id=?", [at, canonicalJson([...byLayer.values()]), String(child.id)]);
    child = { ...child, summary_json: canonicalJson([...byLayer.values()]) };
  }
  const childId = String(child!.id);
  await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [childId, ref]);

  // A parent is earned by actual same-execution backend admission evidence, not
  // a shared model name or timestamps. Works in either arrival order/batch.
  const facts = summaryFacts(child!.summary_json);
  const backend = value.name === "model_step_terminal" ? value : facts.find(v => v.name === "model_step_terminal");
  if (!backend || backend.phase !== "admission" || !["capacity", "ledger_unavailable"].includes(String(backend.failureCode)) || !observationId(backend.serviceEpoch)) return;
  const parentKey = sha256Text(canonicalJson(["service", backend.serviceEpoch, backend.failureCode]));
  // The relation belongs to this failed execution. A delayed Host wrapper must
  // keep its already assigned (possibly resolved) parent, not create a fresh
  // service incident simply because another layer's report arrived later.
  let parent = monitorUuid(child!.parent_id)
    ? await db.first("SELECT id,status FROM incidents WHERE id=? AND scope=? AND rule='shared_runtime_failure' AND occurrence_key=?",[String(child!.parent_id),rootId,parentKey])
    : null;
  parent ??= await db.first("SELECT id,status FROM incidents WHERE scope=? AND agent_id IS NULL AND rule='shared_runtime_failure' AND occurrence_key=? AND status='open'", [rootId, parentKey]);
  if (!parent) {
    const id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,NULL,'shared_runtime_failure','open',?,?,1,?,'condition',?)", [id, rootId, at, at, parentKey, canonicalJson([backend])]);
    await opened(id, null); parent = { id };
  } else if(parent.status !== "resolved") await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?) WHERE id=?", [at, String(parent.id)]);
  await db.run("UPDATE incidents SET parent_id=? WHERE id=?", [String(parent.id), childId]);
  await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [String(parent.id), ref]);
}
