import { Effect } from "effect";
import { continuityId, recordInbound, handoverPolicy, assessRetirement, CurrentStateFailure,
  type BotWorkflowRequest, type InboundWatermark } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson,sha256Text } from "@grokbox/runtime-kernel/hash";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";
export type ConvergenceSample={cursor:string|null;observedAtMs:number;newMessages:number;contiguous:boolean;state:Record<string,unknown>;
  targetUsable:boolean;dependenciesVerified:boolean;resourcesIndependent:boolean;deletionFenceAvailable:boolean};
export type BotConvergencePort={authorize:(request:BotWorkflowRequest)=>Promise<boolean>;
  observe:(request:BotWorkflowRequest,targetId:string,previous:Record<string,unknown>|null)=>Promise<ConvergenceSample>;
  delete:(request:BotWorkflowRequest,targetId:string,evidence:ConvergenceSample)=>Promise<{deleted:boolean;proof:string}>};
const io=<A>(f:()=>Promise<A>)=>Effect.uninterruptible(Effect.tryPromise({try:f,catch:()=>new CurrentStateFailure("native_unavailable")}));

/** Quiet is a coverage-backed observation, not a TTL or an App activity bit.
 * Retirement is an independently authorized operation and cannot be delegated
 * to a model saying that its work is done. */
export function openBotConvergence(input:ContinuityStoreInput & {native:BotConvergencePort}){
  const db=continuityWorkflowPrograms(input);
  const sample=(operationId:string)=>Effect.gen(function*(){
    const request=yield* db.request(operationId),status=yield* db.status(operationId);
    if(request.kind!=="replace"||!status.targetId)return yield* Effect.fail(new CurrentStateFailure("invalid_request"));
    if(!(yield* io(()=>input.native.authorize(request))))return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    const key=continuityId(operationId,"inbound-watermark"),prior=yield* db.subject(key);
    const observed=yield* io(()=>input.native.observe(request,status.targetId!,prior?.data.source??null)).pipe(Effect.catch(()=>Effect.succeed({
      cursor:null,observedAtMs:Date.now(),newMessages:0,contiguous:false,state:prior?.data.source??{},
      targetUsable:false,dependenciesVerified:false,resourcesIndependent:false,deletionFenceAvailable:false,
    } satisfies ConvergenceSample)));
    const watermark=recordInbound(prior?.data.watermark as InboundWatermark??null,observed);
    const items=yield* db.handoverItems(operationId),remaining=items.filter(i=>i.state!=="complete").length,unknown=items.filter(i=>i.state==="effect_unknown").length;
    const assessment=assessRetirement({policy:handoverPolicy(request.handover),nowMs:observed.observedAtMs,createdAtMs:status.createdAtMs,
      inbound:watermark,remaining,unknown,...observed});
    const receipt={operationId,sourceId:request.sourceId,targetId:status.targetId,watermark,assessment,remaining,unknown,
      evidenceHash:sha256Text(canonicalJson([operationId,watermark,remaining,unknown,observed.targetUsable,observed.dependenciesVerified,observed.resourcesIndependent,observed.deletionFenceAvailable]))};
    yield* db.updateSubject(key,prior?.revision??0,status.targetId,0,{watermark,source:observed.state,receipt});
    return {request,targetId:status.targetId,observed,receipt};
  });
  const retire=(operationId:string,expectedEvidence:string)=>Effect.gen(function*(){
    const before=yield* db.subject(continuityId(operationId,"inbound-watermark"));
    if(!before||before.data.receipt?.evidenceHash!==expectedEvidence)return yield* Effect.fail(new CurrentStateFailure("source_changed"));
    const current=yield* sample(operationId);
    if(!current.receipt.assessment.automaticDeleteAuthorized)return {state:"blocked",...current.receipt};
    const control=continuityId(operationId,"retire-source");
    yield* db.reserveControl(control,current.request.sourceId!,"retire-source",{operationId,targetId:current.targetId});
    const record=yield* db.control(control);
    if(record?.state==="complete")return {state:"retired",...record.result};
    if(record?.state!=="prepared")return {state:"unknown",operationId,sourceDeleted:"unknown"};
    yield* db.transitionControl(control,"prepared","effect_unknown",null);
    const result=yield* io(()=>input.native.delete(current.request,current.targetId,current.observed));
    if(!result.deleted)return {state:"unknown",operationId,sourceDeleted:"unknown"};
    yield* db.transitionControl(control,"effect_unknown","complete",result);yield* db.phase(operationId,"retired");
    return {state:"retired",operationId,sourceDeleted:true};
  });
  return {observe:(id:string,signal?:AbortSignal)=>Effect.runPromise(sample(id).pipe(Effect.map(value=>value.receipt)),signal?{signal}:undefined),
    retire:(id:string,hash:string,signal?:AbortSignal)=>Effect.runPromise(retire(id,hash),signal?{signal}:undefined)};
}
