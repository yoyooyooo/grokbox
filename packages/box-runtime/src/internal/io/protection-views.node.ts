import { Effect } from "effect";
import { continuityStorePolicy, isContinuityUuid, isContinuityHash, failContinuity, HANDOVER_KINDS, WORKFLOW_STEPS, botWorkflowRequest, botWorkflowDigest, continuityId } from "@grokbox/runtime-kernel/continuity";
import { continuityDatabase, readContinuityIdentity } from "./continuity-database.node.ts";
import { continuityWorkflowPrograms } from "./continuity-workflows.node.ts";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

const count = (v: unknown, max=Number.MAX_SAFE_INTEGER): number => typeof v==="number" && Number.isSafeInteger(v) && v>=0 && v<=max ? v : failContinuity("integrity_failure");
const timestamp = (v: unknown): number | null => v===null||v===undefined||v===0 ? null : count(v);
const uuid = (v: unknown): string => isContinuityUuid(v)?v:failContinuity("integrity_failure");
const optionalId = (v: unknown) => v===null||v===undefined?null:uuid(v);
const phase = <const T extends readonly string[]>(v: unknown, values: T): T[number] => typeof v==="string" && values.includes(v)?v as T[number]:failContinuity("integrity_failure");
function subject(row: {logicalId:string;currentId:string;generation:number;revision:number;data:any}) {
  const data=row.data;
  if(!data||typeof data!=="object"||!Array.isArray(data.previousIds)||data.previousIds.length>16) return failContinuity("integrity_failure");
  const handovers=data.handoverOperationIds??[];
  if(!Array.isArray(handovers)||handovers.length>16||new Set(handovers).size!==handovers.length
    ||data.handoverHistoryTruncated!==undefined&&typeof data.handoverHistoryTruncated!=="boolean")return failContinuity("integrity_failure");
  const pause=data.pause;
  if(pause!==undefined && (typeof pause.complete!=="boolean"))return failContinuity("integrity_failure");
  const lastActions=["snapshot_saved","snapshot_unavailable","successor_active","prepared","progressing","ready","active","active_with_handover","blocked","retired"];
  return {logicalId:uuid(row.logicalId),currentId:uuid(row.currentId),generation:count(row.generation),revision:count(row.revision),previousIds:(data.previousIds as unknown[]).map(uuid),
    ownership:data.lastState===null?null:phase(data.lastState,["box","temporal","conflict","gap"]),observedAtMs:timestamp(data.lastObservedAtMs),
    lossId:optionalId(data.lossId),lossAtMs:timestamp(data.lossAtMs),lastSnapshotId:optionalId(data.lastSnapshotId),capturedAtMs:timestamp(data.capturedAtMs),pendingOperationId:optionalId(data.pendingOperationId),
    handoverOperationIds:handovers.map(uuid),handoverHistoryTruncated:data.handoverHistoryTruncated??false,
    lastAction:typeof data.lastAction==="string"&&lastActions.includes(data.lastAction)?data.lastAction:null,
    pause:pause?{complete:pause.complete as boolean,remaining:count(pause.remaining,100),failed:count(pause.failed,100)}:null,eventExportPending:data.eventPending!==undefined,eventExportDropped:count(data.eventDropped??0)};
}
/** No source/body read and no initialize/repair/retention side effects. The
 * original CONT owner supplies metadata; raw workflow inputs and manifests
 * never leave this projection even when the stored data contains private text. */
export async function readProtectionSubjects(root: string) {
  const identity=await readContinuityIdentity(root);
  if(!identity)return {scopeId:null,subjects:[],hasMore:false};
  const result=await Effect.runPromise(continuityWorkflowPrograms({durableRoot:root,scopeId:identity.scopeId}).subjects());
  return {scopeId:identity.scopeId,subjects:result.subjects.map(subject),hasMore:result.hasMore};
}
async function database(root: string, scopeId?: string) {
  const identity=await readContinuityIdentity(root);
  if(!identity)return null;
  if(scopeId!==undefined&&scopeId!==identity.scopeId)return failContinuity("scope_mismatch");
  return {scopeId:identity.scopeId,db:continuityDatabase(root,identity.scopeId,continuityStorePolicy(),{})};
}
export async function readProtectionSnapshots(root: string, input: {botId?:string;snapshotId?:string;scopeId?:string;limit:number}) {
  if(input.botId!==undefined)uuid(input.botId);if(input.snapshotId!==undefined)uuid(input.snapshotId);
  count(input.limit,100);if(input.limit<1)return failContinuity("invalid_material");
  const owner=await database(root,input.scopeId);if(!owner)return {scopeId:null,snapshots:[],hasMore:false};
  return Effect.runPromise(owner.db.read(async db=>{
    const rows=await db.all(`SELECT request_id,digest,agent_id,quality,state,created_at FROM publications
      ${input.snapshotId?"WHERE request_id=?":input.botId?"WHERE agent_id=?":""} ORDER BY sequence DESC LIMIT ?`,
      [...(input.snapshotId?[input.snapshotId]:input.botId?[input.botId]:[]),input.limit+1]);
    const snapshots=rows.slice(0,input.limit).map(row=>{
      if(!isContinuityHash(row.digest))return failContinuity("integrity_failure");
      return {id:uuid(row.request_id),botId:uuid(row.agent_id),revision:row.digest,state:phase(row.state,["reserved","published","abandoned","retired"]),
        quality:phase(row.quality,["native_checkpoint","semantic_resume","memory_only"]),capturedAtMs:count(row.created_at)};
    });
    return {scopeId:owner.scopeId,snapshots,hasMore:rows.length>input.limit};
  }));
}
export async function readProtectionHandover(root: string, scopeId: string, operationId: string) {
  uuid(operationId);const owner=await database(root,scopeId);if(!owner)return failContinuity("not_found");
  return Effect.runPromise(owner.db.read(db => readHandoverState(db, owner.scopeId, operationId)));
}
/** One original CONT read transaction supplies the UI revision and mutation
 * precondition. Internal declarations and item bodies never leave the Server. */
export async function readHandoverState(db: MonitorSqlite, scopeId: string, operationId: string) {
    const row=await db.first("SELECT * FROM continuity_workflows WHERE operation_id=?",[uuid(operationId)]);
    if(!row)return failContinuity("not_found");
    const declaration=botWorkflowRequest(JSON.parse(String(row.request_json)));
    if(declaration.scopeId!==scopeId||declaration.operationId!==operationId||botWorkflowDigest(declaration)!==row.digest) return failContinuity("integrity_failure");
    const steps=await db.all("SELECT step,state FROM continuity_steps WHERE operation_id=? ORDER BY step LIMIT 16",[operationId]);
    const duties=await db.all("SELECT item_id,kind,state,input_json,result_json,(result_json IS NOT NULL) AS has_evidence FROM continuity_handover_items WHERE operation_id=? ORDER BY item_id LIMIT 1025",[operationId]);
    if(duties.length>1024)return failContinuity("integrity_failure");
    const inbound=await db.first("SELECT state_json FROM continuity_subjects WHERE logical_id=?",[continuityId(operationId,"inbound-watermark")]);
    const convergence=inbound?JSON.parse(String(inbound.state_json)).receipt:null;
    const revision=sha256Text(canonicalJson([row.digest,row.phase,row.target_id,steps,duties,inbound?.state_json??null]));
    const items=duties.map(item=>({itemId:uuid(item.item_id),kind:phase(item.kind,HANDOVER_KINDS),state:phase(item.state,["prepared","effect_unknown","complete","blocked"]),
      input:JSON.parse(String(item.input_json)),result:item.result_json===null?null:JSON.parse(String(item.result_json)),inputDigest:sha256Text(String(item.input_json))}));
    const totals=await db.first("SELECT COUNT(*) AS n,SUM(state='complete') AS done,SUM(state='effect_unknown') AS unknown_count FROM continuity_handover_items WHERE operation_id=?",[operationId]);
    const complete=count(Number(totals?.done??0),1024),total=count(Number(totals?.n??0),1024),unknown=count(Number(totals?.unknown_count??0),1024);
    return {scopeId,operationId,revision,declaration,items,convergence,sourceId:optionalId(row.source_id),targetId:optionalId(row.target_id),kind:phase(row.kind,["clone","replace","spawn"]),
      phase:phase(row.phase,["prepared","progressing","ready","active","active_with_handover","blocked","retired"]),createdAtMs:count(row.created_at),updatedAtMs:count(row.updated_at),
      steps:steps.map(s=>({step:phase(s.step,WORKFLOW_STEPS),state:phase(s.state,["effect_unknown","complete"])})),
      duties:duties.slice(0,128).map(item=>({itemId:uuid(item.item_id),kind:phase(item.kind,HANDOVER_KINDS),state:phase(item.state,["prepared","effect_unknown","complete","blocked"]),evidenceRecorded:item.has_evidence===1})),
      remaining:total-complete,unknown,complete,moreDuties:duties.length>128};
}
