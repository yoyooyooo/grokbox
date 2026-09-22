import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { botWorkflowRequest, botWorkflowDigest, continuityStorePolicy, failContinuity, isContinuityUuid,
  WORKFLOW_STEPS, continuityId, type BotWorkflowRequest, type WorkflowStep, type WorkflowReceipt,
  selfResetRequest, selfResetDigest, selfResetMaterialRefs, selfResetCurrent, selfResetExecution,
  type SelfResetRequest, type SelfResetReceipt, type SelfResetCurrent, type SelfResetExecution, type SelfResetDutyResult,
  type SelfResetQueueState } from "@grokbox/runtime-kernel/continuity";
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
  const managedRequests = (installationId: string, principalId: string, limit = 20, after?: string) => database.read(async db => {
    id(installationId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(principalId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return failContinuity("invalid_material");
    if (after !== undefined) id(after);
    // Ownership is stored inside the original immutable workflow declaration.
    // Filter before LIMIT, so another principal cannot exhaust this window.
    const records = await db.all("SELECT operation_id FROM continuity_workflows WHERE json_extract(request_json,'$.management.installationId')=? AND json_extract(request_json,'$.management.principalId')=? AND operation_id>? ORDER BY operation_id LIMIT ?", [installationId, principalId, after ?? "", limit + 1]);
    const requests: BotWorkflowRequest[] = [];
    for (const value of records.slice(0, limit)) requests.push((await row(db, String(value.operation_id))).request);
    return { requests, nextCursor: records.length > limit ? requests.at(-1)!.operationId : null };
  });
  const enrollment = () => database.read(async db => {
    // Independent clones/startups may enter default protection once their
    // requested lifecycle is complete. Replacements remain the predecessor's
    // lineage; pending/unknown creation targets must not become a second owner.
    const targets = await db.all(`SELECT DISTINCT w.target_id FROM continuity_workflows w WHERE w.target_id IS NOT NULL AND
      (w.kind='replace' OR NOT EXISTS (SELECT 1 FROM continuity_steps s WHERE s.operation_id=w.operation_id AND s.state='complete' AND
        s.step=CASE WHEN json_extract(w.request_json,'$.start')=1 THEN 'startup' WHEN json_extract(w.request_json,'$.activate')=1 THEN 'activate' ELSE 'initialize' END)) LIMIT 129`);
    const unknown = await db.first("SELECT COUNT(*) AS n FROM continuity_workflows w WHERE target_id IS NULL AND EXISTS (SELECT 1 FROM continuity_steps s WHERE s.operation_id=w.operation_id AND s.step='create' AND s.state='effect_unknown')");
    return { targets:targets.slice(0,128).map(row=>id(String(row.target_id))), hasMore:targets.length>128, unknownCreations:Number(unknown?.n??0) };
  });
  const subjects = (limit = 128) => database.read(async db => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) return failContinuity("invalid_material");
    const rows = await db.all("SELECT * FROM continuity_subjects ORDER BY logical_id LIMIT ?", [limit + 1]);
    return { subjects: rows.slice(0, limit).map(value => ({ logicalId: id(String(value.logical_id)), currentId: id(String(value.current_id)),
      generation: Number(value.generation), revision: Number(value.revision), data: parse(value.state_json) })), hasMore: rows.length > limit };
  });
  const subject = (logicalId: string) => database.read(async db => {
    const value = await db.first("SELECT * FROM continuity_subjects WHERE logical_id=?", [id(logicalId)]);
    return value ? { logicalId, currentId: String(value.current_id), generation: Number(value.generation), revision: Number(value.revision), data: parse(value.state_json) } : null;
  });
  const writeSubject = async (db: MonitorSqlite, logicalId: string, expectedRevision: number, currentId: string, generation: number, raw: unknown) => {
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
  };
  const updateSubject = (logicalId: string, expectedRevision: number, currentId: string, generation: number, raw: unknown) =>
    database.write("continuity-subject", db => writeSubject(db,logicalId,expectedRevision,currentId,generation,raw));
  /** Capture completion only merges its own material fields. Observation may
   * have advanced while the source was read; preserve that newer loss/queue
   * state, and change both the snapshot association and GC pins atomically. */
  const completeSubjectCapture = (input: {logicalId:string;currentId:string;generation:number;requestId:string;snapshotId:string|null;capturedAtMs:number;archive:boolean}) =>
    database.write("continuity-capture-complete", async db => {
      id(input.logicalId);id(input.currentId);id(input.requestId);if(input.snapshotId!==null)id(input.snapshotId);
      if(!Number.isSafeInteger(input.generation)||input.generation<0||!Number.isSafeInteger(input.capturedAtMs)||input.capturedAtMs<1||typeof input.archive!=="boolean")return failContinuity("invalid_material");
      const previous=await db.first("SELECT current_id,generation,revision,state_json FROM continuity_subjects WHERE logical_id=?",[input.logicalId]);
      if(!previous||previous.current_id!==input.currentId||previous.generation!==input.generation)return "superseded" as const;
      const state=parse(previous.state_json);
      if(state.pendingSnapshotId!==input.requestId)return "superseded" as const;
      state.lastAction=input.snapshotId===null?"snapshot_unavailable":"snapshot_saved";
      if(input.snapshotId!==null){
        state.lastSnapshotId=input.snapshotId;state.capturedAtMs=input.capturedAtMs;state.pendingSnapshotId=null;
        state.archiveSnapshotIds=input.archive?[...new Set([...(state.archiveSnapshotIds??[]),input.snapshotId])].slice(-8):[];
      }
      await writeSubject(db,input.logicalId,Number(previous.revision),input.currentId,input.generation,state);
      return state.lastAction as "snapshot_saved"|"snapshot_unavailable";
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

  const selfResetDuties = (request: SelfResetRequest, result: SelfResetExecution | null): SelfResetDutyResult[] =>
    result?.duties ?? request.duties.map(duty => ({ id: duty.id, state: "pending" as const }));
  const selfResetReceipt = (value: any, request: SelfResetRequest, result: SelfResetExecution | null): SelfResetReceipt => ({
    operationId: request.operationId, agentId: request.agentId, state: String(value.state) as SelfResetQueueState,
    requestDigest: selfResetDigest(request), sourceRevision: request.sourceRevision, sourceGeneration: request.sourceGeneration,
    materialRefs: selfResetMaterialRefs(request), workflowRefs: request.workflowRefs,
    duties: selfResetDuties(request, result),
    reason: result?.reason ?? null, createdAtMs: Number(value.created_at), updatedAtMs: Number(value.updated_at)
  });
  const selfResetRow = async (db: MonitorSqlite, operationId: string) => {
    const value = await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [id(operationId)]);
    if (!value || value.kind !== "self-reset") return failContinuity("not_found");
    const request = selfResetRequest(parse(value.request_json));
    if (request.operationId !== operationId || request.scopeId !== input.scopeId || encode(request) !== value.request_json) return failContinuity("integrity_failure");
    const state = String(value.state) as SelfResetQueueState;
    if (!["queued", "effect_unknown", "complete", "blocked", "unknown"].includes(state)) return failContinuity("integrity_failure");
    const result = value.result_json === null ? null : selfResetExecution(parse(value.result_json), request);
    if ((state === "queued" || state === "effect_unknown") && result !== null) return failContinuity("integrity_failure");
    if (state === "complete" && (result === null || result.state !== "complete")) return failContinuity("integrity_failure");
    if ((state === "blocked" || state === "unknown") && (result === null || result.state !== state)) return failContinuity("integrity_failure");
    return { value, request, result };
  };
  const selfResetRequestFor = (operationId: string) => database.read(async db => (await selfResetRow(db, operationId)).request);
  const verifySelfResetRefs = async (db: MonitorSqlite, request: SelfResetRequest) => {
    for (const ref of selfResetMaterialRefs(request)) {
      const publication = await db.first("SELECT state,digest FROM publications WHERE request_id=?", [ref.ref]);
      if (!publication || publication.state !== "published" || String(publication.digest) !== ref.revision) return failContinuity("conflict");
    }
    for (const ref of request.workflowRefs) {
      const workflow = await db.first("SELECT digest FROM continuity_workflows WHERE operation_id=?", [ref.operationId]);
      if (!workflow || String(workflow.digest) !== ref.digest) return failContinuity("conflict");
    }
  };
  const enqueueSelfReset = (raw: SelfResetRequest) => database.write("self-reset-enqueue", async db => {
    const request = selfResetRequest(raw);
    if (request.scopeId !== input.scopeId) return failContinuity("scope_mismatch");
    const encoded = encode(request);
    const prior = await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [request.operationId]);
    if (prior) {
      if (prior.agent_id !== request.agentId || prior.kind !== "self-reset" || prior.request_json !== encoded) return failContinuity("conflict");
      const saved = await selfResetRow(db, request.operationId);
      return { created: false, receipt: selfResetReceipt(saved.value, saved.request, saved.result) };
    }
    const pending = await db.first("SELECT operation_id FROM continuity_queued_controls WHERE agent_id=? AND kind='self-reset' AND state IN ('queued','effect_unknown') LIMIT 1", [request.agentId]);
    if (pending) return failContinuity("busy");
    await verifySelfResetRefs(db, request);
    await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 8192);
    const now = Date.now();
    await db.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'queued',NULL,?,?)", [request.operationId, request.agentId, "self-reset", encoded, now, now]);
    const saved = await selfResetRow(db, request.operationId);
    return { created: true, receipt: selfResetReceipt(saved.value, saved.request, saved.result) };
  });
  const selfReset = (operationId: string) => database.read(async db => {
    const saved = await selfResetRow(db, operationId);
    return selfResetReceipt(saved.value, saved.request, saved.result);
  });
  const claimSelfReset = (operationId: string, raw: SelfResetCurrent) => database.write("self-reset-claim", async db => {
    const saved = await selfResetRow(db, operationId);
    const current = selfResetCurrent(raw);
    if (saved.value.state !== "queued") return { dispatch: false, receipt: selfResetReceipt(saved.value, saved.request, saved.result) };
    if (current.sourceRevision !== saved.request.sourceRevision || current.sourceGeneration !== saved.request.sourceGeneration) {
      const execution: SelfResetExecution = {
        state: "blocked",
        duties: saved.request.duties.map(duty => ({ id: duty.id, state: "blocked" as const, reason: "source_changed" })),
        reason: "source_changed"
      };
      const encoded = encode(execution);
      await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 4096);
      await db.run("UPDATE continuity_queued_controls SET state='blocked',result_json=?,updated_at=? WHERE operation_id=?", [encoded, Date.now(), operationId]);
      const next = await selfResetRow(db, operationId);
      return { dispatch: false, receipt: selfResetReceipt(next.value, next.request, next.result) };
    }
    await db.run("UPDATE continuity_queued_controls SET state='effect_unknown',updated_at=? WHERE operation_id=?", [Date.now(), operationId]);
    const next = await selfResetRow(db, operationId);
    return { dispatch: true, receipt: selfResetReceipt(next.value, next.request, next.result) };
  });
  const settleSelfReset = (operationId: string, raw: unknown) => database.write("self-reset-settle", async db => {
    const saved = await selfResetRow(db, operationId);
    const execution = selfResetExecution(raw, saved.request);
    if (saved.value.state !== "effect_unknown") {
      if (saved.result && canonicalJson(saved.result) === canonicalJson(execution)) return selfResetReceipt(saved.value, saved.request, saved.result);
      return failContinuity("conflict");
    }
    const encoded = encode(execution);
    await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 4096);
    await db.run("UPDATE continuity_queued_controls SET state=?,result_json=?,updated_at=? WHERE operation_id=?", [execution.state, encoded, Date.now(), operationId]);
    const next = await selfResetRow(db, operationId);
    return selfResetReceipt(next.value, next.request, next.result);
  });
  const listSelfResets = (agentId: string, limit = 64) => database.read(async db => {
    id(agentId);
    const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= 128 ? limit : failContinuity("invalid_material");
    const rows = await db.all("SELECT * FROM continuity_queued_controls WHERE agent_id=? AND kind='self-reset' ORDER BY created_at LIMIT ?", [agentId, bounded]);
    return rows.map(value => {
      const request = selfResetRequest(parse(value.request_json));
      const result = value.result_json === null ? null : selfResetExecution(parse(value.result_json), request);
      return selfResetReceipt(value, request, result);
    });
  });
  return { initialize: database.initialize, create, request, step, beginStep, completeStep, phase, status, list,
    subject, subjects, enrollment, managedRequests, updateSubject, completeSubjectCapture, handoverItems, putHandover, settleHandover,control,reserveControl,transitionControl,
    enqueueSelfReset, selfReset, selfResetRequest: selfResetRequestFor, claimSelfReset, settleSelfReset, listSelfResets };
}
