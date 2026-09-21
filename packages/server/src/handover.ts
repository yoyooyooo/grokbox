import { Effect } from "effect";
import { botRef, protectionReference, protectionReferenceIdentity, normalizeHandoverChange, normalizeHandoverContinuation,
  handoverOperationRef, handoverOperationIdentity, handoverEvidenceRef, handoverEvidenceIdentity, handoverOperation, handoverAssessment,
  ManagementClientError, type ProtectionHandover, type HandoverAssessment, type HandoverResult, type HandoverOperation, type HandoverAction, type Capability } from "@grokbox/client/contract";
import { botWorkflowDigest, continuityId, ContinuityFailure, CurrentStateFailure, handoverPolicy, type BotWorkflowRequest, type HandoverPlanItem } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { readProtectionHandover, handoverManagementPrograms, handoverControlId, contextStorePresent, withManagedLifecycleGate,
  createNativeBotHandover, createNativeBotConvergence, createNativeBotProtection, reconcileBotRetirement, replacementIsActivated,
  type ManagedHandoverRow, type ManagedHandoverDeclaration, type HandoverEffect } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { managedWorkflowId } from "./lifecycle.ts";
import type { ContextDomain } from "./context.ts";
type Snapshot = Awaited<ReturnType<typeof readProtectionHandover>>;
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const missing=()=>new HttpFailure(404,"not_found","No handover request or observation belongs to this installation and principal.");
const changed=()=>new HttpFailure(409,"revision_conflict","The original handover, successor, policy or observed evidence changed; no replacement effect was authorized.");
function failure(e:unknown):HttpFailure {
  if(e instanceof HttpFailure)return e;
  if(e instanceof ManagementClientError)return new HttpFailure(e.code==="wrong_installation"?409:400,e.code,e.message);
  if(e instanceof ContinuityFailure||e instanceof CurrentStateFailure){
    if(e.code==="not_found")return missing();
    if(["conflict","policy_changed","not_prepared"].includes(e.code))return changed();
    if(["scope_mismatch","source_changed"].includes(e.code))return new HttpFailure(409,"source_changed","The handover account or native generation changed.");
    if(e.code==="capacity")return new HttpFailure(507,"store_full","The original CONT owner cannot admit more requests without losing protected history.");
    if(e.code==="commit_unknown")return new HttpFailure(409,"operation_unknown","Read the original handover request; acknowledgment does not determine whether its transaction committed.");
  }
  return new HttpFailure(503,"source_unavailable","The original handover store or bounded native source is unavailable.");
}
const io=<A>(run:(signal:AbortSignal)=>Promise<A>)=>Effect.tryPromise({try:run,catch:failure});
function owned<A>(run:(signal:AbortSignal)=>Promise<A>){return Effect.scoped(Effect.gen(function*(){
  const task=yield* Effect.acquireRelease(Effect.sync(()=>{const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
    const promise=run(signal);void promise.catch(()=>undefined);return {controller,promise};}),t=>Effect.promise(async()=>{t.controller.abort();await t.promise.catch(()=>undefined);}));
  return yield* io(()=>task.promise);
}));}
function assessment(s:Snapshot):HandoverAssessment|null {
  const c=s.convergence;if(c===null)return null;
  if(!c||c.operationId!==s.operationId||c.sourceId!==s.sourceId||c.targetId!==s.targetId||!c.watermark||!c.assessment)throw new ContinuityFailure("integrity_failure");
  const v={evidenceHash:c.evidenceHash,observedAtMs:c.watermark.lastObservedAtMs,healthySinceMs:c.watermark.healthySinceMs,lastActivityAtMs:c.watermark.lastActivityAtMs,
    newMessages:c.watermark.newMessages,coverage:c.watermark.coverage,gap:c.watermark.gap,eligible:c.assessment.eligible,automaticDeleteAuthorized:c.assessment.automaticDeleteAuthorized,blockers:c.assessment.blockers};
  if(!handoverAssessment(v))throw new ContinuityFailure("integrity_failure");return v;
}
export function projectHandover(installation:string,s:Snapshot):ProtectionHandover {
  const policy=handoverPolicy(s.declaration.handover);
  return {handoverRef:protectionReference("handover",installation,s.scopeId,s.operationId),revision:s.revision,activated:replacementIsActivated(s.declaration,s),
    userMessagesConfigured:policy.allowUserMessages,automaticDeleteConfigured:policy.automaticDelete,assessment:assessment(s),
    sourceBotRef:s.sourceId?botRef(installation,s.sourceId):null,targetBotRef:s.targetId?botRef(installation,s.targetId):null,phase:s.phase,kind:s.kind as ProtectionHandover["kind"],
    createdAtMs:s.createdAtMs,updatedAtMs:s.updatedAtMs,steps:s.steps,duties:s.duties,remaining:s.remaining,unknown:s.unknown,complete:s.complete,moreDuties:s.moreDuties,
    targetUsability:"not-observed",retirementEligibility:"not-observed",privateInputsIncluded:false};
}
const capabilities=(action:HandoverAction):Capability[]=>["handover.write",...(action==="attest"?["handover.attest" as const]:action==="retire"?["handover.retire" as const]:[])];
async function authorize(d:ContextDomain,p:Principal,action:HandoverAction,signal:AbortSignal){for(const cap of capabilities(action)){requireCapability(p,cap);await d.authorize(signal,cap);}signal.throwIfAborted();}
function origin(d:ContextDomain,p:Principal,r:BotWorkflowRequest){
  if(!r.management)return;
  const m=r.management;
  if(m.installationId!==d.installationId||m.principalId!==p.id||r.operationId!==managedWorkflowId(d.installationId,p.id,m.requestId))throw missing();
}
async function row(d:ContextDomain,p:Principal,scopeId:string,requestId:string){
  if(!await contextStorePresent(d.root,scopeId))return null;
  return Effect.runPromise(handoverManagementPrograms(d.root,scopeId).read(handoverControlId(d.installationId,p.id,requestId)));
}
function project(d:ContextDomain,r:ManagedHandoverRow):HandoverOperation {
  const q=r.declaration,v={requestId:q.requestId,operationRef:handoverOperationRef(d.installationId,q.scopeId,q.requestId),handoverRef:protectionReference("handover",d.installationId,q.scopeId,q.workflowId),
    action:q.action,expectedRevision:q.expectedRevision,state:r.cancelled?"cancelled":r.result?"completed":r.state==="prepared"?"admitted":"unknown",result:r.result,createdAtMs:r.createdAtMs,privateInputsIncluded:false};
  if(!handoverOperation(v,d.installationId,q.scopeId,q.requestId))throw new ContinuityFailure("integrity_failure");return v;
}
function summary(s:Snapshot,outcome:HandoverResult["outcome"],reason:string|null=null):HandoverResult{return {outcome,reason,revision:s.revision,remaining:s.remaining,unknown:s.unknown,complete:s.complete,
  assessment:assessment(s),observations:[],observationsTruncated:false,sourceDeleted:outcome==="retired",allDutiesComplete:false};}
async function evidence(d:ContextDomain,p:Principal,q:ManagedHandoverDeclaration){
  if(!q.evidenceRef)throw changed();
  const ref=q.action==="attest"?handoverEvidenceIdentity(q.evidenceRef,d.installationId):handoverOperationIdentity(q.evidenceRef,d.installationId);
  const record=await row(d,p,ref.scopeId,ref.requestId);if(!record)throw missing();const proof=project(d,record);
  if(record.declaration.action!=="observe"||record.declaration.workflowId!==q.workflowId||proof.state!=="completed"||proof.result?.outcome!=="observed")throw changed();
  if(q.action==="attest"&&!proof.result.observations.some(o=>o.itemId===q.itemId&&o.state==="complete"&&o.evidenceRef===q.evidenceRef))throw new HttpFailure(400,"invalid_input","No completed duty observation backs this exact evidence reference.");
  return proof;
}
export function handoverApplication(d:ContextDomain,p:Principal,method:string,url:URL,input?:unknown){return Effect.gen(function*(){
  yield* Effect.try({try:()=>{if(url.search)throw new HttpFailure(400,"invalid_input","This handover endpoint accepts no query parameters.");requireCapability(p,method==="GET"?"operations.read":"handover.write");},catch:failure});
  const get=/^\/v1\/handover-operations\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
  if(method==="GET"&&get)return yield* io(async()=>{const r=await row(d,p,get[1]!,get[2]!);if(!r)throw missing();return project(d,r);});
  const continuation=url.pathname==="/v1/handover-continuations";
  if(method!=="POST"||(!continuation&&url.pathname!=="/v1/handover-changes"))return yield* Effect.fail(new HttpFailure(404,"not_found","This handover endpoint does not exist."));
  const command=yield* Effect.try({try:()=>continuation?normalizeHandoverContinuation(input):normalizeHandoverChange(input,d.installationId),catch:failure});
  return yield* owned(async signal=>{
    const ref="handoverRef" in command?protectionReferenceIdentity(command.handoverRef,d.installationId,"handover"):null,scopeId=ref?.scopeId??("scopeId" in command?command.scopeId:"");
    const verify=(r:ManagedHandoverRow)=>{if("handoverRef" in command&&(r.declaration.workflowId!==ref!.id||r.declaration.action!==command.action||r.declaration.expectedRevision!==command.expectedRevision
      ||r.declaration.itemId!==(command.itemId??null)||r.declaration.evidenceRef!==(command.evidenceRef??null)))throw new HttpFailure(409,"idempotency_conflict","This request is bound to another immutable handover action.");};
    const before=await row(d,p,scopeId,command.requestId);
    if(before){verify(before);if(!continuation||before.state==="complete")return project(d,before);}else if(continuation)throw missing();
    const operation=await withManagedLifecycleGate(d.root,async()=>{
      let r=await row(d,p,scopeId,command.requestId);if(r){verify(r);if(!continuation||r.state==="complete")return project(d,r);}
      const owner=handoverManagementPrograms(d.root,scopeId,d.hooks),id=handoverControlId(d.installationId,p.id,command.requestId),action=r?.declaration.action??("handoverRef" in command?command.action:"observe");
      await authorize(d,p,action,signal);
      if(continuation&&command.action==="cancel")return project(d,await Effect.runPromise(owner.cancel(id)));
      let s=await readProtectionHandover(d.root,scopeId,r?.declaration.workflowId??ref!.id);origin(d,p,s.declaration);
      if(r&&(r.declaration.workflowDigest!==botWorkflowDigest(s.declaration)||r.declaration.sourceId!==s.sourceId||r.declaration.targetId!==s.targetId))throw changed();
      if(!r||r.state==="prepared"){
        if(s.revision!==(r?.declaration.expectedRevision??("expectedRevision" in command?command.expectedRevision:""))||!replacementIsActivated(s.declaration,s))throw changed();
      }
      if(r?.state==="effect_unknown"&&action==="retire"&&continuation&&command.action==="reconcile"){
        // Reconciliation must never sample a fresh deletion opportunity. It
        // consumes only the original inner retirement receipt, even offline.
        const retired=await reconcileBotRetirement({durableRoot:d.root,scopeId},r.declaration.workflowId,"explicit",d.hooks,signal);
        if(retired.state!=="retired")return project(d,r);
        await authorize(d,p,action,signal);
        s=await readProtectionHandover(d.root,scopeId,r.declaration.workflowId);
        return project(d,await Effect.runPromise(owner.settle(id,summary(s,"retired") as unknown as Record<string,unknown>)));
      }
      if(!d.context)throw new CurrentStateFailure("native_unavailable");const context=d.context(signal);
      const authorized=async(request:BotWorkflowRequest)=>{
        origin(d,p,request);await authorize(d,p,action,signal);
        if(action==="advance"&&handoverPolicy(request.handover).allowUserMessages){requireCapability(p,"handover.messages");await d.authorize(signal,"handover.messages");}
        if(!request.management){requireCapability(p,"protection.write");await d.authorize(signal,"protection.write");return (await createNativeBotProtection(context,scopeId).lifecycle.authorize(request,"handover")).allowed;}
        return true;
      };
      const native=createNativeBotHandover(context,scopeId,10000,authorized,d.hooks),convergence=createNativeBotConvergence(context,scopeId,authorized,d.hooks);
      if(!await native.port.authorize(s.declaration))throw changed();
      if(!r){
        if(!("handoverRef" in command))throw missing();
        const q:ManagedHandoverDeclaration={installationId:d.installationId,principalId:p.id,requestId:command.requestId,scopeId,workflowId:s.operationId,workflowDigest:botWorkflowDigest(s.declaration),
          sourceId:s.sourceId!,targetId:s.targetId!,action:command.action,expectedRevision:command.expectedRevision,itemId:command.itemId??null,evidenceRef:command.evidenceRef??null};
        if(q.evidenceRef)await evidence(d,p,q);
        r=await Effect.runPromise(owner.reserve(q));
      }
      if(continuation&&command.action==="reconcile"&&r.state==="prepared")return project(d,r);
      try{
        if(r.state==="prepared")r=(await Effect.runPromise(owner.claim(id))).row;
        await authorize(d,p,action,signal);
        const q=r.declaration;let result:HandoverResult;
        if(action==="advance"){
          if(continuation&&command.action==="reconcile")await native.program.reconcile(q.workflowId,64,signal);else await native.program.advance(q.workflowId,16,signal);
          s=await readProtectionHandover(d.root,scopeId,q.workflowId);result=summary(s,"advanced",continuation?"continued_original_duties":null);
        }else if(action==="observe"){
          const completed=new Map<string,HandoverEffect>(s.items.filter(i=>i.state==="complete").map(i=>[i.itemId,i.result]));
          const observations:HandoverResult["observations"]=[];
          for(const item of s.items.slice(0,64)){
            if(!await native.port.authorize(s.declaration))throw changed();
            const {dependsOn,...data}=item.input;if(!Array.isArray(dependsOn)||data.targetId!==s.targetId)throw new ContinuityFailure("integrity_failure");
            const input:HandoverPlanItem={itemId:item.itemId,kind:item.kind as HandoverPlanItem["kind"],dependsOn,input:data};
            const effect=await native.port.inspect(s.declaration,input,completed).catch(()=>({state:"unknown" as const}));
            if(!await native.port.authorize(s.declaration))throw changed();
            const digest=effect.state==="complete"&&"evidence" in effect&&hash(effect.evidence)?effect.evidence:null;
            observations.push({itemId:item.itemId,inputDigest:item.inputDigest,state:effect.state==="complete"&&!digest?"unknown":effect.state,evidenceHash:digest,
              evidenceRef:digest?handoverEvidenceRef(d.installationId,scopeId,q.requestId,item.itemId,digest):null});
          }
          await convergence.program.observe(q.workflowId,signal);s=await readProtectionHandover(d.root,scopeId,q.workflowId);
          result={...summary(s,"observed"),observations,observationsTruncated:s.items.length>64};
        }else if(action==="attest"){
          const proof=await evidence(d,p,q),observed=proof.result!.observations.find(o=>o.itemId===q.itemId&&o.evidenceRef===q.evidenceRef),item=s.items.find(i=>i.itemId===q.itemId);
          if(!observed||observed.state!=="complete"||!observed.evidenceHash||!item||observed.inputDigest!==item.inputDigest)throw changed();
          const {dependsOn,...data}=item.input,completed=new Map<string,HandoverEffect>(s.items.filter(i=>i.state==="complete").map(i=>[i.itemId,i.result]));
          if(!Array.isArray(dependsOn)||dependsOn.some(id=>!completed.has(id))||data.targetId!==s.targetId)throw changed();
          const effect=await native.port.inspect(s.declaration,{itemId:item.itemId,kind:item.kind as HandoverPlanItem["kind"],dependsOn,input:data},completed);
          if(!await native.port.authorize(s.declaration))throw changed();
          if(effect.state!=="complete"||effect.evidence!==observed.evidenceHash)result=summary(s,"blocked","evidence_changed");
          else{
            result=summary(s,"attested");
            const nativeResult:Record<string,unknown>={state:"complete",evidence:effect.evidence};
            for(const k of ["targetId","routineId","revision"] as const)if(typeof effect[k]==="string"&&effect[k]!.length<=256)nativeResult[k]=effect[k];
            await authorize(d,p,action,signal);
            return project(d,await Effect.runPromise(owner.settle(id,result as unknown as Record<string,unknown>,{itemId:item.itemId,inputDigest:item.inputDigest,evidenceHash:effect.evidence,nativeResult})));
          }
        }else{
          const proof=await evidence(d,p,q);
          if(!proof.result!.assessment||s.convergence?.evidenceHash!==proof.result!.assessment.evidenceHash)result=summary(s,"blocked","evidence_changed");
          else{
            const retired=await convergence.program.retire(q.workflowId,proof.result!.assessment.evidenceHash,"explicit",signal);
            if(retired.state==="unknown")return project(d,r);
            s=await readProtectionHandover(d.root,scopeId,q.workflowId);
            result=summary(s,retired.state==="retired"&&retired.sourceDeleted===true?"retired":"blocked",retired.state==="retired"?null:"retirement_conditions_unmet");
          }
        }
        await authorize(d,p,action,signal);return project(d,await Effect.runPromise(owner.settle(id,result as unknown as Record<string,unknown>)));
      }catch(error){
        const retained=await row(d,p,scopeId,command.requestId);if(!retained)throw error;if(retained.state==="prepared")throw error;return project(d,retained);
      }
    },signal);
    if(operation)return operation;const running=await row(d,p,scopeId,command.requestId);if(running){verify(running);return project(d,running);}
    throw new HttpFailure(503,"unavailable","Another lifecycle driver owns this installation; no new handover request was admitted.");
  });
});}
