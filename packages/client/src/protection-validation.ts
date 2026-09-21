import { UUID, botIdFromRef, type ProtectionOverview, type ProtectionBotView, type ProtectionOperation, type ProtectionSnapshot, type ProtectionSnapshotList, type ProtectionHandover, type ProtectionWorkerView, type ProtectionSubject } from "./contract.ts";
import { validProtectionPatch, protectionReferenceIdentity } from "./protection-contract.ts";
import { exact, record, revision } from "./response-validation.ts";
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const time=(v:unknown)=>v===null||integer(v,1);
const optionalId=(v:unknown)=>v===null||typeof v==="string"&&UUID.test(v);
const bot=(v:unknown,installationId:string)=>{try{return typeof v==="string"&&v===`bot:${installationId}:${botIdFromRef(v,installationId)}`;}catch{return false;}};
const ref=(v:unknown,installationId:string,kind:"snapshot"|"handover")=>{try{return typeof v==="string"&&protectionReferenceIdentity(v,installationId,kind).ref===v;}catch{return false;}};
const sameScope=(v:string,scopeId:string|null)=>scopeId!==null&&v.split(":")[2]===scopeId;
const states=["starting","disabled","idle","running","blocked","stopping","stopped"];
const reasons=["not-observed","policy-disabled","native-adapter-unavailable","source-unavailable","scope-mismatch","store-unavailable","schema-mismatch","competing-owner","no-qualified-bots","target-capacity","configuration-unavailable","target-identity-conflict","active","stopped"];
export function protectionWorker(v:unknown):v is ProtectionWorkerView {
  return record(v)&&exact(v,["owner","state","reason","scopeId","scopeObservedAtMs","policyRevision","targets","discovered","rosterSize","discoveryCoverage","startedAtMs","replacements","defaultProtection","nativeExecutionProven","bootInstalled"])
    &&v.owner==="management-server"&&states.includes(String(v.state))&&reasons.includes(String(v.reason))&&(v.scopeId===null||revision(v.scopeId))&&time(v.scopeObservedAtMs)&&(v.policyRevision===null||revision(v.policyRevision))
    &&integer(v.targets,0,128)&&integer(v.discovered,0,128)&&integer(v.rosterSize,0,4352)&&["not-observed","rotating-batch","observed-window","capacity-limited","creation-pending"].includes(String(v.discoveryCoverage))
    &&integer(v.startedAtMs,1)&&integer(v.replacements)&&v.defaultProtection===true&&v.nativeExecutionProven===false&&v.bootInstalled===false;
}
export function protectionSubject(v:unknown,installationId:string,scopeId:string|null):v is ProtectionSubject {
  return record(v)&&exact(v,["botRef","currentBotRef","previousBotRefs","generation","revision","ownership","observedAtMs","freshness","lossId","lossAtMs","lastSnapshotRef","capturedAtMs","pendingHandoverRef","handoverRefs","handoverHistoryTruncated","lastAction","pause","eventExportPending","eventExportDropped","notificationDelivery"])
    &&bot(v.botRef,installationId)&&bot(v.currentBotRef,installationId)&&Array.isArray(v.previousBotRefs)&&v.previousBotRefs.length<=16&&v.previousBotRefs.every(id=>bot(id,installationId))
    &&new Set(v.previousBotRefs).size===v.previousBotRefs.length&&integer(v.generation)&&integer(v.revision,1)&&(v.ownership===null||["box","temporal","conflict","gap"].includes(String(v.ownership)))
    &&time(v.observedAtMs)&&["fresh","stale","not-observed"].includes(String(v.freshness))&&optionalId(v.lossId)&&time(v.lossAtMs)&&time(v.capturedAtMs)
    &&(v.lastSnapshotRef===null||ref(v.lastSnapshotRef,installationId,"snapshot")&&sameScope(String(v.lastSnapshotRef),scopeId))
    &&(v.pendingHandoverRef===null||ref(v.pendingHandoverRef,installationId,"handover")&&sameScope(String(v.pendingHandoverRef),scopeId))
    &&Array.isArray(v.handoverRefs)&&v.handoverRefs.length<=16&&new Set(v.handoverRefs).size===v.handoverRefs.length
    &&v.handoverRefs.every(id=>ref(id,installationId,"handover")&&sameScope(String(id),scopeId))&&typeof v.handoverHistoryTruncated==="boolean"
    &&(v.lastAction===null||["snapshot_saved","snapshot_unavailable","successor_active","prepared","progressing","ready","active","active_with_handover","blocked","retired"].includes(String(v.lastAction)))
    &&(v.pause===null||record(v.pause)&&exact(v.pause,["complete","remaining","failed"])&&typeof v.pause.complete==="boolean"&&integer(v.pause.remaining,0,100)&&integer(v.pause.failed,0,100))
    &&typeof v.eventExportPending==="boolean"&&integer(v.eventExportDropped)&&v.notificationDelivery==="not-observed";
}
export function protectionOverview(v:unknown,installationId:string):v is ProtectionOverview {
  return record(v)&&exact(v,["revision","enabled","intervalMs","defaultPolicy","worker","store","scopeId","subjects","hasMore","overrides","currentOwnershipProven"])
    &&revision(v.revision)&&typeof v.enabled==="boolean"&&integer(v.intervalMs,10000,300000)&&validProtectionPatch(v.defaultPolicy,true)&&protectionWorker(v.worker)
    &&["not-initialized","observed","unavailable"].includes(String(v.store))&&(v.scopeId===null||revision(v.scopeId))&&Array.isArray(v.subjects)&&v.subjects.length<=128
    &&v.subjects.every(row=>protectionSubject(row,installationId,v.scopeId as string|null))&&new Set(v.subjects.map(row=>row.botRef)).size===v.subjects.length
    &&(v.store==="observed"?v.scopeId!==null:v.subjects.length===0&&v.scopeId===null)&&typeof v.hasMore==="boolean"&&Array.isArray(v.overrides)&&v.overrides.length<=128
    &&v.overrides.every(row=>record(row)&&exact(row,["botRef","policy"])&&bot(row.botRef,installationId)&&validProtectionPatch(row.policy,true))
    &&new Set(v.overrides.map(row=>row.botRef)).size===v.overrides.length&&v.currentOwnershipProven===false;
}
export function protectionBot(v:unknown,installationId:string,target:string):v is ProtectionBotView {
  return record(v)&&exact(v,["revision","enabled","botRef","policy","policySource","subject","store","scopeId","protectionApplied"])
    &&v.botRef===target&&bot(v.botRef,installationId)&&revision(v.revision)&&typeof v.enabled==="boolean"&&validProtectionPatch(v.policy,true)
    &&["default","override"].includes(String(v.policySource))&&["not-initialized","observed","unavailable"].includes(String(v.store))&&(v.scopeId===null||revision(v.scopeId))
    &&(v.subject===null||protectionSubject(v.subject,installationId,v.scopeId as string|null)&&v.subject.botRef===target)&&v.protectionApplied==="not-observed";
}
export function protectionOperation(v:unknown,installationId:string,target:string,requestId:string,before?:string):v is ProtectionOperation {
  return record(v)&&exact(v,["requestId","operationRef","targetRef","state","beforeRevision","revision","application","nativeEffectsPerformed"])
    &&v.requestId===requestId&&v.targetRef===target&&typeof v.operationRef==="string"&&v.operationRef.startsWith(`protection-operation:${installationId}:`)
    &&revision(v.operationRef.split(":")[2])&&v.operationRef.split(":").length===3&&["succeeded","unknown"].includes(String(v.state))
    &&revision(v.beforeRevision)&&(before===undefined||v.beforeRevision===before)&&(v.state==="succeeded"?revision(v.revision):v.revision===null)
    &&v.application==="not-observed"&&v.nativeEffectsPerformed===false;
}
export function protectionSnapshot(v:unknown,installationId:string):v is ProtectionSnapshot {
  return record(v)&&exact(v,["snapshotRef","botRef","revision","state","quality","capturedAtMs","contentIncluded","nativeImportProven"])
    &&ref(v.snapshotRef,installationId,"snapshot")&&bot(v.botRef,installationId)&&revision(v.revision)&&["reserved","published","abandoned","retired"].includes(String(v.state))
    &&["native_checkpoint","semantic_resume","memory_only"].includes(String(v.quality))&&integer(v.capturedAtMs,1)&&v.contentIncluded===false&&v.nativeImportProven===false;
}
export function protectionSnapshots(v:unknown,installationId:string,target:string,limit:number):v is ProtectionSnapshotList {
  return record(v)&&exact(v,["botRef","scopeId","snapshots","hasMore","coverage"])&&v.botRef===target&&(v.scopeId===null||revision(v.scopeId))
    &&Array.isArray(v.snapshots)&&v.snapshots.length<=limit&&v.snapshots.every(row=>protectionSnapshot(row,installationId)&&row.botRef===target&&sameScope(row.snapshotRef,v.scopeId as string|null))
    &&new Set(v.snapshots.map(row=>row.snapshotRef)).size===v.snapshots.length&&typeof v.hasMore==="boolean"&&v.coverage==="retained-metadata";
}
import { handoverAssessment } from "./handover-contract.ts";
export function protectionHandover(v:unknown,installationId:string,target:string):v is ProtectionHandover {
  return record(v)&&exact(v,["handoverRef","revision","activated","userMessagesConfigured","automaticDeleteConfigured","assessment","sourceBotRef","targetBotRef","phase","kind","createdAtMs","updatedAtMs","steps","duties","remaining","unknown","complete","moreDuties","targetUsability","retirementEligibility","privateInputsIncluded"])
    &&revision(v.revision)&&typeof v.activated==="boolean"&&typeof v.userMessagesConfigured==="boolean"&&typeof v.automaticDeleteConfigured==="boolean"&&(v.assessment===null||handoverAssessment(v.assessment))
    &&v.handoverRef===target&&ref(target,installationId,"handover")&&(v.sourceBotRef===null||bot(v.sourceBotRef,installationId))&&(v.targetBotRef===null||bot(v.targetBotRef,installationId))
    &&["prepared","progressing","ready","active","active_with_handover","blocked","retired"].includes(String(v.phase))&&["clone","replace","spawn"].includes(String(v.kind))
    &&integer(v.createdAtMs,1)&&integer(v.updatedAtMs,Number(v.createdAtMs))&&Array.isArray(v.steps)&&v.steps.length<=16
    &&v.steps.every(s=>record(s)&&exact(s,["step","state"])&&["capture","create","load","model","compose","initialize","activate","startup","handover"].includes(String(s.step))&&["effect_unknown","complete"].includes(String(s.state)))
    &&(!v.activated||v.kind==="replace"&&v.phase!=="retired"&&v.sourceBotRef!==null&&v.targetBotRef!==null&&v.sourceBotRef!==v.targetBotRef&&["create","initialize","activate"].every(step=>(v.steps as any[]).some(s=>s.step===step&&s.state==="complete")))
    &&Array.isArray(v.duties)&&v.duties.length<=128&&v.duties.every(d=>record(d)&&exact(d,["itemId","kind","state","evidenceRecorded"])&&typeof d.itemId==="string"&&UUID.test(d.itemId)
      &&["old-guidance","title-old","title-new","sidebar","group-notice","group-members","dm-notice","routine-create","routine-stop","routine-enable","external-task"].includes(String(d.kind))
      &&["prepared","effect_unknown","complete","blocked"].includes(String(d.state))&&typeof d.evidenceRecorded==="boolean")
    &&new Set(v.duties.map(d=>d.itemId)).size===v.duties.length&&integer(v.remaining,0,1024)&&integer(v.unknown,0,Number(v.remaining))&&integer(v.complete,0,1024)
    &&Number(v.remaining)+Number(v.complete)<=1024&&typeof v.moreDuties==="boolean"&&v.targetUsability==="not-observed"&&v.retirementEligibility==="not-observed"&&v.privateInputsIncluded===false;
}
