import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { botWorkflowRequest, botWorkflowDigest, continuityStorePolicy, failContinuity, isContinuityUuid,
  WORKFLOW_STEPS, continuityId, type BotWorkflowRequest, type WorkflowStep, type WorkflowReceipt } from "@grokbox/runtime-kernel/continuity";
import { continuityDatabase, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import type { ContinuityStoreInput } from "./continuity-store.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

function safeData(raw: unknown, depth = 0): any {
  if (depth > 6) return failContinuity("invalid_material");
  if (raw === null || typeof raw === "boolean" || typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length <= 65536 && !raw.includes("\0")) return raw;
  if (Array.isArray(raw) && raw.length <= 512) return raw.map(v => safeData(v, depth + 1));
  if (!raw || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length > 64) return failContinuity("invalid_material");
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) return failContinuity("invalid_material");
    const p = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!("value" in p)) return failContinuity("invalid_material");
    if (p.value !== undefined) out[key] = safeData(p.value, depth + 1);
  }
  return out;
}
const encode = (raw: unknown, max = 128 * 1024) => { const text = canonicalJson(safeData(raw)); if (Buffer.byteLength(text) > max) return failContinuity("capacity"); return text; };
const id = (v: string) => { if (!isContinuityUuid(v)) return failContinuity("invalid_material"); return v; };
const token = (v: string) => { if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(v)) return failContinuity("invalid_material"); return v; };
const parse = (value: unknown): any => { if (typeof value !== "string" || value.length > 256 * 1024) return failContinuity("integrity_failure"); try { return JSON.parse(value); } catch { return failContinuity("integrity_failure"); } };

/** Management progress, not the native current-state writer or permission. */
export function continuityWorkflowPrograms(input: ContinuityStoreInput, hooks: ContinuityStoreHooks = {}) {
  const database = continuityDatabase(input.durableRoot, input.scopeId, continuityStorePolicy(input.policy), hooks);
  const row = async (db: MonitorSqlite, operationId: string) => {
    const value = await db.first("SELECT * FROM continuity_workflows WHERE operation_id=?", [id(operationId)]);
    if (!value) return failContinuity("not_found");
    const request = botWorkflowRequest(parse(value.request_json));
    if (request.operationId !== operationId || request.scopeId !== input.scopeId || botWorkflowDigest(request) !== value.digest) return failContinuity("integrity_failure");
    return { value, request };
  };
  const create = (raw: BotWorkflowRequest) => database.write("workflow-prepare", async db => {
    const request = botWorkflowRequest(raw), digest = botWorkflowDigest(request);
    if (request.scopeId !== input.scopeId) return failContinuity("scope_mismatch");
    const prior = await db.first("SELECT * FROM continuity_workflows WHERE operation_id=?", [request.operationId]);
    if (prior) { if (prior.digest !== digest) return failContinuity("conflict"); return request; }
    if (request.kind === "replace" && await db.first("SELECT operation_id FROM continuity_workflows WHERE source_id=? AND kind='replace' AND phase NOT IN ('active_with_handover','retired') LIMIT 1", [request.sourceId!])) return failContinuity("conflict");
    const encoded = canonicalJson(request);
    await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 16384);
    const now = Date.now();
    await db.run("INSERT INTO continuity_workflows VALUES(?,?,?,?,?,NULL,'prepared',?,?)", [request.operationId, digest, encoded, request.kind, request.sourceId, now, now]);
    // Reserve protection before an asynchronous capture can publish. The GC
    // shares this database boundary; a workflow reference is not a log lease.
    for (const snapshotId of new Set([request.snapshotId, continuityId(request.operationId, "source-snapshot"), continuityId(request.operationId, "target-snapshot")].filter((v): v is string => v !== null))) {
      await db.run("INSERT INTO continuity_workflow_materials VALUES(?,?)", [request.operationId, snapshotId]);
    }
    return request;
  });
  const request = (operationId: string) => database.read(async db => (await row(db, operationId)).request);
  const step = (operationId: string, step: WorkflowStep) => database.read(async db => {
    await row(db, operationId); if (!WORKFLOW_STEPS.includes(step)) return failContinuity("invalid_material");
    const value = await db.first("SELECT * FROM continuity_steps WHERE operation_id=? AND step=?", [operationId, step]);
    return value ? { step, state: String(value.state), result: value.result_json === null ? null : parse(value.result_json), inputDigest: String(value.input_digest) } : null;
  });
  const beginStep = (operationId: string, step: WorkflowStep) => database.write("workflow-step-claim", async db => {
    const { request } = await row(db, operationId); if (!WORKFLOW_STEPS.includes(step)) return failContinuity("invalid_material");
    const digest = sha256Text(canonicalJson([botWorkflowDigest(request), step]));
    const previous = await db.first("SELECT * FROM continuity_steps WHERE operation_id=? AND step=?", [operationId, step]);
    if (previous) {
      if (previous.input_digest !== digest) return failContinuity("conflict");
      return { dispatch: false, state: String(previous.state), result: previous.result_json === null ? null : parse(previous.result_json) };
    }
    await database.metadataRoom(db, 8192);
    await db.run("INSERT INTO continuity_steps VALUES(?,?,?,'effect_unknown',NULL,?)", [operationId, step, digest, Date.now()]);
    await db.run("UPDATE continuity_workflows SET phase='progressing',updated_at=? WHERE operation_id=?", [Date.now(), operationId]);
    return { dispatch: true, state: "effect_unknown", result: null };
  });
  const completeStep = (operationId: string, step: WorkflowStep, raw: unknown) => database.write("workflow-step-complete", async db => {
    await row(db, operationId);
    const value = await db.first("SELECT * FROM continuity_steps WHERE operation_id=? AND step=?", [operationId, step]);
    if (!value) return failContinuity("not_found");
    const encoded = encode(raw);
    if (value.state === "complete") { if (encoded !== value.result_json) return failContinuity("conflict"); return parse(encoded); }
    await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 4096);
    if (step === "create") {
      const result = parse(encoded); if (!isContinuityUuid(result.agentId)) return failContinuity("invalid_material");
      await db.run("UPDATE continuity_workflows SET target_id=? WHERE operation_id=?", [result.agentId, operationId]);
    }
    await db.run("UPDATE continuity_steps SET state='complete',result_json=?,updated_at=? WHERE operation_id=? AND step=?", [encoded, Date.now(), operationId, step]);
    return parse(encoded);
  });
  const phase = (operationId: string, next: WorkflowReceipt["phase"] | "retired") => database.write("workflow-phase", async db => {
    await row(db, operationId);
    if (!["prepared", "progressing", "ready", "active", "active_with_handover", "blocked", "retired"].includes(next)) return failContinuity("invalid_material");
    await db.run("UPDATE continuity_workflows SET phase=?,updated_at=? WHERE operation_id=?", [next, Date.now(), operationId]);
  });
  const status = (operationId: string) => database.read(async db => {
    const { value, request } = await row(db, operationId), steps = await db.all("SELECT step,state,result_json FROM continuity_steps WHERE operation_id=? ORDER BY step", [operationId]);
    const publicResult = (v: any) => {
      const out: Record<string, unknown> = {};
      for (const key of ["agentId", "snapshotId", "revision", "quality", "state", "started", "activated", "modelId", "modelRevision", "assignmentRevision", "scopeId", "operationId", "gaps", "count", "remaining", "aborted", "paused", "businessComplete", "deliveryVerified"]) if (v?.[key] !== undefined) out[key] = safeData(v[key]);
      return out;
    };
    return { operationId, kind: request.kind, sourceId: request.sourceId, targetId: value.target_id as string | null, phase: String(value.phase),
      steps: steps.map(s => ({ step: String(s.step), state: String(s.state), result: s.result_json === null ? null : publicResult(parse(s.result_json)) })),
      policyRevision: request.policyRevision, createdAtMs: Number(value.created_at), updatedAtMs: Number(value.updated_at) };
  });
  const list = (limit = 64) => database.read(async db => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) return failContinuity("invalid_material");
    return db.all("SELECT operation_id,kind,source_id,target_id,phase,updated_at FROM continuity_workflows ORDER BY updated_at DESC LIMIT ?", [limit]);
  });
  const subject = (logicalId: string) => database.read(async db => {
    const value = await db.first("SELECT * FROM continuity_subjects WHERE logical_id=?", [id(logicalId)]);
    return value ? { logicalId, currentId: String(value.current_id), generation: Number(value.generation), revision: Number(value.revision), data: parse(value.state_json) } : null;
  });
  const updateSubject = (logicalId: string, expectedRevision: number, currentId: string, generation: number, raw: unknown) => database.write("continuity-subject", async db => {
    id(logicalId); id(currentId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(generation) || generation < 0) return failContinuity("invalid_material");
    const previous = await db.first("SELECT revision FROM continuity_subjects WHERE logical_id=?", [logicalId]);
    if ((previous?.revision ?? 0) !== expectedRevision) return failContinuity("conflict");
    const encoded = encode(raw); await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 8192);
    await db.run("INSERT INTO continuity_subjects VALUES(?,?,?,?,?,?) ON CONFLICT(logical_id) DO UPDATE SET current_id=excluded.current_id,generation=excluded.generation,revision=excluded.revision,state_json=excluded.state_json,updated_at=excluded.updated_at",
      [logicalId, currentId, generation, expectedRevision + 1, encoded, Date.now()]);
    const state = parse(encoded);
    if (state.archiveSnapshotIds !== undefined && (!Array.isArray(state.archiveSnapshotIds) || state.archiveSnapshotIds.length > 8)) return failContinuity("invalid_material");
    const references = [state.lastSnapshotId, state.pendingSnapshotId, ...(state.archiveSnapshotIds ?? []),
      ...(state.pendingSnapshotId ? [continuityId(id(state.pendingSnapshotId), "memory-only")] : [])].filter((v): v is string => v != null);
    for (const value of references) id(value);
    await db.run("DELETE FROM continuity_subject_materials WHERE logical_id=?", [logicalId]);
    for (const value of new Set(references)) await db.run("INSERT INTO continuity_subject_materials VALUES(?,?)", [logicalId, value]);
    return expectedRevision + 1;
  });
  const handoverItems = (operationId: string) => database.read(async db => { await row(db, operationId); return (await db.all("SELECT * FROM continuity_handover_items WHERE operation_id=? ORDER BY item_id LIMIT 1025", [operationId])).map(v => ({
    itemId: String(v.item_id), kind: String(v.kind), state: String(v.state), input: parse(v.input_json), result: v.result_json === null ? null : parse(v.result_json) })); });
  const putHandover = (operationId: string, itemId: string, kind: string, raw: unknown) => database.write("handover-plan", async db => {
    await row(db, operationId); id(itemId); token(kind); const encoded = encode(raw);
    const prior = await db.first("SELECT * FROM continuity_handover_items WHERE operation_id=? AND item_id=?", [operationId, itemId]);
    if (prior) { if (prior.input_json !== encoded || prior.kind !== kind) return failContinuity("conflict"); return; }
    if (Number((await db.first("SELECT COUNT(*) n FROM continuity_handover_items WHERE operation_id=?", [operationId]))?.n) >= 1024) return failContinuity("capacity");
    await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 8192);
    await db.run("INSERT INTO continuity_handover_items VALUES(?,?,?,'prepared',?,NULL,?)", [operationId, itemId, kind, encoded, Date.now()]);
  });
  const settleHandover = (operationId: string, itemId: string, expected: string, next: string, raw: unknown) => database.write("handover-progress", async db => {
    id(operationId); id(itemId);
    if (!["prepared", "effect_unknown", "complete", "blocked"].includes(next)) return failContinuity("invalid_material");
    const value = await db.first("SELECT * FROM continuity_handover_items WHERE operation_id=? AND item_id=?", [operationId, itemId]);
    if (!value || value.state !== expected) return failContinuity("conflict");
    const encoded = raw === null ? null : encode(raw);
    if (encoded) await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 4096);
    await db.run("UPDATE continuity_handover_items SET state=?,result_json=?,updated_at=? WHERE operation_id=? AND item_id=?", [next, encoded, Date.now(), operationId, itemId]);
  });
  const control = (operationId:string) => database.read(async db => {
    const row = await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?",[id(operationId)]);
    return row ? {operationId,agentId:String(row.agent_id),kind:String(row.kind),state:String(row.state),request:parse(row.request_json),result:row.result_json===null?null:parse(row.result_json),createdAtMs:Number(row.created_at)} : null;
  });
  const reserveControl = (operationId:string,agentId:string,kind:string,raw:unknown) => database.write("control-prepare",async db=>{
    id(operationId);id(agentId);token(kind);const encoded=encode(raw);
    const row=await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?",[operationId]);
    if(row){if(row.agent_id!==agentId||row.kind!==kind||row.request_json!==encoded)return failContinuity("conflict");return {created:false,state:String(row.state)};}
    await database.metadataRoom(db,Buffer.byteLength(encoded)*2+8192);
    await db.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'prepared',NULL,?,?)",[operationId,agentId,kind,encoded,Date.now(),Date.now()]);
    return {created:true,state:"prepared"};
  });
  const transitionControl=(operationId:string,expected:string,next:string,raw:unknown)=>database.write("control-transition",async db=>{
    id(operationId);if(!["prepared","effect_unknown","complete","blocked"].includes(next))return failContinuity("invalid_material");
    const row=await db.first("SELECT state FROM continuity_queued_controls WHERE operation_id=?",[operationId]);
    if(!row||row.state!==expected)return failContinuity("conflict");const encoded=raw===null?null:encode(raw);
    if(encoded)await database.metadataRoom(db,Buffer.byteLength(encoded)*2+4096);
    await db.run("UPDATE continuity_queued_controls SET state=?,result_json=?,updated_at=? WHERE operation_id=?",[next,encoded,Date.now(),operationId]);return {state:next};
  });
  return { initialize: database.initialize, create, request, step, beginStep, completeStep, phase, status, list,
    subject, updateSubject, handoverItems, putHandover, settleHandover,control,reserveControl,transitionControl };
}
