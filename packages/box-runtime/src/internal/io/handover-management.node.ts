import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { continuityId, continuityStorePolicy, isContinuityHash, isContinuityUuid, botWorkflowDigest, ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { continuityDatabase, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import { readHandoverState } from "./protection-views.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

export type ManagedHandoverDeclaration = { installationId: string; principalId: string; requestId: string; scopeId: string; workflowId: string;
  workflowDigest: string; sourceId: string; targetId: string; expectedRevision: string; action: "advance" | "observe" | "attest" | "retire";
  itemId: string | null; evidenceRef: string | null };
export type ManagedHandoverRow = { declaration: ManagedHandoverDeclaration; operationId: string; state: "prepared" | "effect_unknown" | "complete";
  result: Record<string, unknown> | null; cancelled: boolean; createdAtMs: number };
export const handoverControlId = (installation: string, principal: string, request: string) => continuityId(installation, canonicalJson(["managed-handover-v1", principal, request]));
const bad = (): never => { throw new ContinuityFailure("integrity_failure"); };
function declaration(raw: unknown): ManagedHandoverDeclaration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== "action,evidenceRef,expectedRevision,installationId,itemId,principalId,requestId,scopeId,sourceId,targetId,workflowDigest,workflowId") return bad();
  const v = raw as ManagedHandoverDeclaration;
  if (![v.installationId,v.requestId,v.workflowId,v.sourceId,v.targetId].every(isContinuityUuid) || v.sourceId===v.targetId
    || ![v.scopeId,v.expectedRevision,v.workflowDigest].every(isContinuityHash) || typeof v.principalId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(v.principalId)
    || !["advance","observe","attest","retire"].includes(v.action) || !(v.itemId===null||isContinuityUuid(v.itemId))
    || !(v.evidenceRef===null||typeof v.evidenceRef==="string"&&v.evidenceRef.length<=350) || (v.action==="attest")!==(v.itemId!==null)
    || (["attest","retire"].includes(v.action))!==(v.evidenceRef!==null)) return bad();
  return structuredClone(v);
}
/** Original CONT control rows only. Per-duty effects remain owned by handover;
 * these records fence management submission/recovery, not native execution. */
export function handoverManagementPrograms(root: string, scopeId: string, hooks: ContinuityStoreHooks = {}) {
  const db=continuityDatabase(root,scopeId,continuityStorePolicy(),hooks);
  const readRow=async(c:MonitorSqlite,id:string):Promise<ManagedHandoverRow|null>=>{
    if(!isContinuityUuid(id))return bad();
    const r=await c.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?",[id]);if(!r)return null;
    if(r.kind!=="managed-handover"||typeof r.request_json!=="string"||r.request_json.length>4096||!["prepared","effect_unknown","complete"].includes(String(r.state)))return bad();
    const q=declaration(JSON.parse(r.request_json));
    if(q.scopeId!==scopeId||r.agent_id!==q.sourceId||id!==handoverControlId(q.installationId,q.principalId,q.requestId)||!Number.isSafeInteger(r.created_at)||Number(r.created_at)<1)return bad();
    let result:Record<string,unknown>|null=null,cancelled=false;
    if(r.result_json!==null){
      if(r.state!=="complete"||typeof r.result_json!=="string"||r.result_json.length>131072)return bad();
      const parsed=JSON.parse(r.result_json);
      if(canonicalJson(parsed)===canonicalJson({cancelledBeforeDispatch:true}))cancelled=true;
      else if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))result=parsed;else return bad();
    }
    if(r.state==="complete"&&!result&&!cancelled)return bad();
    return {declaration:q,operationId:id,state:r.state as ManagedHandoverRow["state"],result,cancelled,createdAtMs:Number(r.created_at)};
  };
  return {
    read:(id:string)=>db.read(c=>readRow(c,id)),
    reserve:(raw:ManagedHandoverDeclaration)=>db.write("managed-handover-prepare",async c=>{
      const q=declaration(raw),id=handoverControlId(q.installationId,q.principalId,q.requestId),old=await readRow(c,id);
      if(old){if(canonicalJson(q)!==canonicalJson(old.declaration))throw new ContinuityFailure("conflict");return old;}
      const current=await readHandoverState(c,scopeId,q.workflowId);
      if(current.revision!==q.expectedRevision||current.sourceId!==q.sourceId||current.targetId!==q.targetId)throw new ContinuityFailure("conflict");
      if(botWorkflowDigest(current.declaration)!==q.workflowDigest)throw new ContinuityFailure("conflict");
      if(await c.first("SELECT operation_id FROM continuity_queued_controls WHERE kind='managed-handover' AND state!='complete' AND json_extract(request_json,'$.workflowId')=? LIMIT 1",[q.workflowId]))throw new ContinuityFailure("conflict");
      if(Number((await c.first("SELECT COUNT(*) n FROM continuity_queued_controls WHERE kind='managed-handover'"))?.n)>=512)throw new ContinuityFailure("capacity");
      const text=canonicalJson(q),now=Date.now();await db.metadataRoom(c,Buffer.byteLength(text)*2+16384);
      await c.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'prepared',NULL,?,?)",[id,q.sourceId,"managed-handover",text,now,now]);return (await readRow(c,id))!;
    }),
    claim:(id:string)=>db.write("managed-handover-claim",async c=>{
      const row=await readRow(c,id);if(!row)throw new ContinuityFailure("not_found");if(row.state!=="prepared")return {dispatch:false,row};
      await c.run("UPDATE continuity_queued_controls SET state='effect_unknown',updated_at=? WHERE operation_id=?",[Date.now(),id]);return {dispatch:true,row:(await readRow(c,id))!};
    }),
    settle:(id:string,value:Record<string,unknown>,attestation?:{itemId:string;inputDigest:string;evidenceHash:string;nativeResult:Record<string,unknown>})=>db.write("managed-handover-settle",async c=>{
      const row=await readRow(c,id);if(!row)throw new ContinuityFailure("not_found");
      if(row.state==="prepared"||row.cancelled)throw new ContinuityFailure("conflict");
      if(row.result){if(canonicalJson(row.result)!==canonicalJson(value))throw new ContinuityFailure("conflict");return row;}
      let result=structuredClone(value);
      if(attestation){
        if(row.declaration.action!=="attest"||attestation.itemId!==row.declaration.itemId||!isContinuityHash(attestation.inputDigest)||!isContinuityHash(attestation.evidenceHash))return bad();
        const current=await readHandoverState(c,scopeId,row.declaration.workflowId),item=current.items.find(i=>i.itemId===attestation.itemId);
        if(botWorkflowDigest(current.declaration)!==row.declaration.workflowDigest||current.sourceId!==row.declaration.sourceId
          ||current.targetId!==row.declaration.targetId||!item||item.inputDigest!==attestation.inputDigest
          ||!Array.isArray(item.input.dependsOn)||item.input.dependsOn.some((id:unknown)=>!current.items.some(i=>i.itemId===id&&i.state==="complete")))throw new ContinuityFailure("conflict");
        await c.run("UPDATE continuity_handover_items SET state='complete',result_json=?,updated_at=? WHERE operation_id=? AND item_id=?",
          [canonicalJson({...attestation.nativeResult,state:"complete",evidence:attestation.evidenceHash,proof:"native_reobserved"}),Date.now(),row.declaration.workflowId,attestation.itemId]);
        const after=await readHandoverState(c,scopeId,row.declaration.workflowId);
        result={...result,revision:after.revision,remaining:after.remaining,unknown:after.unknown,complete:after.complete,allDutiesComplete:false};
      }
      const text=canonicalJson(result);if(Buffer.byteLength(text)>65536)throw new ContinuityFailure("capacity");await db.metadataRoom(c,Buffer.byteLength(text)*2+8192);
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?",[text,Date.now(),id]);return (await readRow(c,id))!;
    }),
    cancel:(id:string)=>db.write("managed-handover-cancel",async c=>{
      const row=await readRow(c,id);if(!row)throw new ContinuityFailure("not_found");if(row.cancelled)return row;if(row.state!=="prepared")throw new ContinuityFailure("conflict");
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?",[canonicalJson({cancelledBeforeDispatch:true}),Date.now(),id]);return (await readRow(c,id))!;
    }),
  };
}
