import { Effect } from "effect";
import { continuityId, isContinuityUuid, recordInbound, handoverPolicy, assessRetirement, CurrentStateFailure, ContinuityFailure,
  type BotWorkflowRequest, type InboundWatermark } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson,sha256Text } from "@grokbox/runtime-kernel/hash";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";
import { replacementIsActivated } from "./bot-handover.runtime.ts";
export type ConvergenceSample={cursor:string|null;observedAtMs:number;newMessages:number;contiguous:boolean;state:Record<string,unknown>;
  targetUsable:boolean;dependenciesVerified:boolean;resourcesIndependent:boolean;deletionFenceAvailable:boolean};
export type BotConvergencePort={authorize:(request:BotWorkflowRequest)=>Promise<boolean>;
  observe:(request:BotWorkflowRequest,targetId:string,previous:Record<string,unknown>|null)=>Promise<ConvergenceSample>;
  delete:(request:BotWorkflowRequest,targetId:string,evidence:ConvergenceSample)=>Promise<{deleted:boolean;proof:string}>};
const io=<A>(f:()=>Promise<A>)=>Effect.uninterruptible(Effect.tryPromise({try:f,catch:()=>new CurrentStateFailure("native_unavailable")}));

/** Quiet is a coverage-backed observation, not a TTL or an App activity bit.
 * Retirement is an independently authorized operation and cannot be delegated
 * to a model saying that its work is done. */
export function openBotConvergence(input:ContinuityStoreInput & {native:BotConvergencePort},hooks:ContinuityStoreHooks={}){
  const db=continuityWorkflowPrograms(input,hooks);
  const sample=(operationId:string)=>Effect.gen(function*(){
    const request=yield* db.request(operationId),status=yield* db.status(operationId);
    if(!replacementIsActivated(request,status))return yield* Effect.fail(new CurrentStateFailure("not_prepared"));
    if(!(yield* io(()=>input.native.authorize(request))))return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    const key=continuityId(operationId,"inbound-watermark"),prior=yield* db.subject(key);
    const observed=yield* io(()=>input.native.observe(request,status.targetId!,prior?.data.source??null)).pipe(Effect.catch(()=>Effect.succeed({
      cursor:null,observedAtMs:Date.now(),newMessages:0,contiguous:false,state:prior?.data.source??{},
      targetUsable:false,dependenciesVerified:false,resourcesIndependent:false,deletionFenceAvailable:false,
    } satisfies ConvergenceSample)));
    if(!(yield* io(()=>input.native.authorize(request))))return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    const watermark=recordInbound(prior?.data.watermark as InboundWatermark??null,observed);
    const items=yield* db.handoverItems(operationId),remaining=items.filter(i=>i.state!=="complete").length,unknown=items.filter(i=>i.state==="effect_unknown").length;
    const assessment=assessRetirement({policy:handoverPolicy(request.handover),nowMs:observed.observedAtMs,createdAtMs:status.createdAtMs,
      inbound:watermark,remaining,unknown,...observed});
    const receipt={operationId,sourceId:request.sourceId,targetId:status.targetId,watermark,assessment,remaining,unknown,
      evidenceHash:sha256Text(canonicalJson([operationId,watermark,remaining,unknown,observed.targetUsable,observed.dependenciesVerified,observed.resourcesIndependent,observed.deletionFenceAvailable]))};
    yield* db.updateSubject(key,prior?.revision??0,status.targetId!,0,{watermark,source:observed.state,receipt});
    return {request,targetId:status.targetId!,observed,receipt};
  });
  const retire=(operationId:string,expectedEvidence:string,authorization:"explicit"|"automatic")=>Effect.gen(function*(){
    if(!["explicit","automatic"].includes(authorization))return yield* Effect.fail(new CurrentStateFailure("invalid_request"));
    const control=continuityId(operationId,"retire-source"), retained=yield* db.control(control);
    if(retained&&(retained.kind!=="retire-source"||retained.request.operationId!==operationId||retained.request.authorization!==authorization))return yield* Effect.fail(new ContinuityFailure("conflict"));
    if(retained?.state==="complete") { yield* db.phase(operationId,"retired"); return retained.result; }
    if(retained&&retained.state!=="prepared")return {state:"unknown",operationId,sourceDeleted:"unknown"};
    const before=yield* db.subject(continuityId(operationId,"inbound-watermark"));
    if(!before||before.data.receipt?.evidenceHash!==expectedEvidence)return yield* Effect.fail(new CurrentStateFailure("source_changed"));
    const current=yield* sample(operationId);
    if(!(authorization==="explicit"?current.receipt.assessment.eligible:current.receipt.assessment.automaticDeleteAuthorized))return {state:"blocked",...current.receipt};
    yield* db.reserveControl(control,current.request.sourceId!,"retire-source",{operationId,targetId:current.targetId,authorization});
    const record=yield* db.control(control);
    if(record?.state==="complete")return {state:"retired",...record.result};
    if(record?.state!=="prepared")return {state:"unknown",operationId,sourceDeleted:"unknown"};
    yield* db.transitionControl(control,"prepared","effect_unknown",null);
    if(!(yield* io(()=>input.native.authorize(current.request))))return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    const result=yield* io(()=>input.native.delete(current.request,current.targetId,current.observed));
    if(!result.deleted)return {state:"unknown",operationId,sourceDeleted:"unknown"};
    const receipt={state:"retired",operationId,sourceDeleted:true,proof:result.proof};
    yield* db.transitionControl(control,"effect_unknown","complete",receipt);yield* db.phase(operationId,"retired");
    return receipt;
  });
  return {observe:(id:string,signal?:AbortSignal)=>Effect.runPromise(sample(id).pipe(Effect.map(value=>value.receipt)),signal?{signal}:undefined),
    reconcileRetirement:(id:string,authorization:"explicit"|"automatic",signal?:AbortSignal)=>reconcileBotRetirement(input,id,authorization,hooks,signal),
    retire:(id:string,hash:string,authorization:"explicit"|"automatic",signal?:AbortSignal)=>Effect.runPromise(retire(id,hash,authorization),signal?{signal}:undefined)};
}

/** Original retirement metadata only. This program has no native port and
 * cannot turn a missing effect record into an execution opportunity. */
export function reconcileBotRetirement(input:ContinuityStoreInput,operationId:string,authorization:"explicit"|"automatic",hooks:ContinuityStoreHooks={},signal?:AbortSignal){
  const db=continuityWorkflowPrograms(input,hooks);
  const program=Effect.gen(function*(){
    // Only the original durable native-deletion receipt can finish reconciliation.
    // Missing, prepared or uncertain records are not permission to observe-and-delete.
    if(!isContinuityUuid(operationId)||!["explicit","automatic"].includes(authorization))return yield* Effect.fail(new CurrentStateFailure("invalid_request"));
    const request=yield* db.request(operationId),status=yield* db.status(operationId),record=yield* db.control(continuityId(operationId,"retire-source"));
    if(!record)return {state:"not-dispatched" as const,operationId,sourceDeleted:false as const};
    if(record.kind!=="retire-source"||record.agentId!==request.sourceId||record.request.operationId!==operationId
      ||record.request.targetId!==status.targetId||record.request.authorization!==authorization)return yield* Effect.fail(new ContinuityFailure("integrity_failure"));
    if(record.state!=="complete")return {state:"unknown" as const,operationId,sourceDeleted:"unknown" as const};
    const result=record.result;
    if(!result||result.state!=="retired"||result.operationId!==operationId||result.sourceDeleted!==true
      ||typeof result.proof!=="string"||!result.proof||result.proof.length>4096)return yield* Effect.fail(new ContinuityFailure("integrity_failure"));
    // Repair only the local phase from the already-settled original receipt;
    // a disappeared source need not be contacted again to establish this fact.
    if(status.phase!=="retired")yield* db.phase(operationId,"retired");
    return {state:"retired" as const,operationId,sourceDeleted:true as const,proof:result.proof};
  });
  return Effect.runPromise(program,signal?{signal}:undefined);
}
