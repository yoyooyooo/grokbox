import { Effect, Fiber } from "effect";
import { ContinuityFailure, CurrentStateFailure, continuityId, continuityProtection, protectionRevision, replacementBudget,
  type BotProtection, type BotWorkflowRequest, type ContinuityProtection } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";
import { openBotLifecycle, type BotLifecyclePort } from "./bot-lifecycle.runtime.ts";

type Observation = { state: "box" | "temporal" | "conflict" | "gap"; scopeId: string; atMs: number };
type SubjectData = { lastState: Observation["state"] | null; lastObservedAtMs: number; lossId: string | null; lossAtMs: number | null;
  lastSnapshotId: string | null; capturedAtMs: number; replacementTimes: number[]; pendingOperationId: string | null;
  lastAction: string | null; previousIds: string[]; eventPending?: { id: string; atMs: number; kind: "ownership_lost" | "source_gap" | "ownership_observed" };
  pause?: { complete: boolean; remaining: number; failed: number }; pendingSnapshotId?: string | null; archiveSnapshotIds?: string[] };
const empty = (): SubjectData => ({lastState:null,lastObservedAtMs:0,lossId:null,lossAtMs:null,lastSnapshotId:null,capturedAtMs:0,replacementTimes:[],pendingOperationId:null,lastAction:null,previousIds:[]});
export type BotProtectionPort = {
  policy: () => Promise<ContinuityProtection>;
  observe: (agentIds: readonly string[]) => Promise<ReadonlyMap<string,Observation>>;
  pause: (agentId:string,lossId:string,policy:BotProtection,logicalId:string) => Promise<{complete:boolean;remaining:number;failed:number}>;
  notify: (logicalId:string,agentId:string,event:NonNullable<SubjectData["eventPending"]>) => Promise<boolean>;
  capture: (logicalId:string,agentId:string,operationId:string,policy:BotProtection) => Promise<{snapshotId:string}>;
  request: (logicalId:string,agentId:string,operationId:string,snapshotId:string|null,policy:BotProtection) => Promise<BotWorkflowRequest>;
  lifecycle: BotLifecyclePort;
  handover: (operationId:string) => Promise<unknown>;
};
const io = <A>(f:()=>Promise<A>) => Effect.uninterruptible(Effect.tryPromise({try:f,catch:e=>e instanceof CurrentStateFailure||e instanceof ContinuityFailure?e:new CurrentStateFailure("native_unavailable")}));
const clock = (at:number) => Number.isSafeInteger(at)&&at>0;

/** Separate observation and advancement lanes: a slow clone cannot suppress
 * timely loss detection/notification. The persistent subject CAS precedes any
 * action; only the exact recorded operation may construct a replacement. */
export function openBotProtection(input:ContinuityStoreInput & {native:BotProtectionPort}) {
  const db=continuityWorkflowPrograms(input), native=input.native;
  let observeOffset=0, advanceOffset=0, handoverOffset=0;
  const observed=()=>Effect.gen(function*(){
    const policy=continuityProtection(yield* io(native.policy));
    if(!policy.enabled)return {state:"off",observed:0,actions:0};
    yield* db.initialize();
    const ids=Object.keys(policy.bots).filter(id=>policy.bots[id]!.enabled).sort();
    if(!ids.length)return {state:"idle",observed:0,actions:0};
    const batch=Array.from({length:Math.min(16,ids.length)},(_,n)=>ids[(observeOffset+n)%ids.length]!);observeOffset=(observeOffset+batch.length)%ids.length;
    const subjects: Array<{logicalId:string;currentId:string;row:{revision:number;generation:number;currentId:string;data:any}|null}>=[];
    for(const logicalId of batch){const row=yield* db.subject(logicalId);subjects.push({logicalId,row,currentId:row?.currentId??logicalId});}
    const samples=yield* io(()=>native.observe(subjects.map(s=>s.currentId))).pipe(Effect.catch(()=>Effect.succeed(new Map<string,Observation>())));
    let actions=0;
    for(const subject of subjects){
      const {logicalId,row,currentId}=subject,p=policy.bots[logicalId]!,now=Date.now();
      const candidate=samples.get(currentId),sample:Observation=candidate&&candidate.scopeId===input.scopeId&&clock(candidate.atMs)&&now>=candidate.atMs&&now-candidate.atMs<=5000?candidate:{state:"gap",scopeId:input.scopeId,atMs:now};
      const prior=row?(row.data as SubjectData):empty(),data:SubjectData={...prior,lastState:sample.state,lastObservedAtMs:sample.atMs};
      const loss=sample.state==="temporal"||sample.state==="conflict";
      if(loss&&prior.lossId===null){data.lossId=continuityId(logicalId,`loss:${row?.generation??0}:${sample.atMs}`);data.lossAtMs=sample.atMs;
        data.eventPending={id:data.lossId,atMs:sample.atMs,kind:"ownership_lost"};data.pause=undefined;}
      else if(sample.state==="gap"&&prior.lastState!=="gap"&&!data.eventPending)data.eventPending={id:continuityId(logicalId,`gap:${sample.atMs}`),atMs:sample.atMs,kind:"source_gap"};
      else if(sample.state==="box"&&prior.lastState!=="box"&&!data.eventPending)data.eventPending={id:continuityId(logicalId,`box:${sample.atMs}`),atMs:sample.atMs,kind:"ownership_observed"};
      // Scope belongs to this declared installation. A failed CAS cannot act on
      // a different controller's newly promoted successor.
      let revision:number;
      const write=yield* Effect.result(db.updateSubject(logicalId,row?.revision??0,currentId,row?.generation??0,data));
      if(write._tag==="Failure")continue;revision=write.success;
      if(data.eventPending){
        const delivered=yield* io(()=>native.notify(logicalId,currentId,data.eventPending!)).pipe(Effect.catch(()=>Effect.succeed(false)));
        if(delivered){data.eventPending=undefined;actions++;}
      }
      const fresh=continuityProtection(yield* io(native.policy));
      if(!fresh.enabled||!fresh.bots[logicalId]?.enabled||protectionRevision(logicalId,fresh.bots[logicalId]!)!==protectionRevision(logicalId,p))continue;
      if(loss&&data.lossId&&p.pauseOnOwnershipLoss&&data.pause?.complete!==true){
        data.pause=yield* io(()=>native.pause(currentId,data.lossId!,p,logicalId)).pipe(Effect.catch(()=>Effect.succeed({complete:false,remaining:0,failed:1})));actions++;
      }
      yield* db.updateSubject(logicalId,revision,currentId,row?.generation??0,data).pipe(Effect.catch(()=>Effect.succeed(0)));
    }
    return {state:"observed",observed:batch.length,total:ids.length,actions,coverage:batch.length===ids.length?"all_configured":"rotating_batch"};
  });
  const advance=()=>Effect.gen(function*(){
    const policy=continuityProtection(yield* io(native.policy));if(!policy.enabled)return {state:"off"};
    yield* db.initialize();const ids=Object.keys(policy.bots).filter(id=>policy.bots[id]!.enabled).sort();if(!ids.length)return {state:"idle"};
    const logicalId=ids[advanceOffset++%ids.length]!,p=policy.bots[logicalId]!,row=yield* db.subject(logicalId);if(!row)return {state:"awaiting_observation"};
    const data={...row.data} as SubjectData,currentId=row.currentId,now=Date.now();let revision=row.revision;
    if(data.lastState==="box"&&p.tier!=="observe"&&now-data.capturedAtMs>=p.captureIntervalMs){
      const snapshotId=data.pendingSnapshotId??continuityId(logicalId,`snapshot:${row.generation}:${Math.floor(now/p.captureIntervalMs)}`);
      data.pendingSnapshotId=snapshotId;
      revision=yield* db.updateSubject(logicalId,revision,currentId,row.generation,data);
      const result=yield* Effect.result(io(()=>native.capture(logicalId,currentId,snapshotId,p)));
      const latest=yield* db.subject(logicalId);
      if(!latest||latest.currentId!==currentId||latest.generation!==row.generation)return {state:"superseded"};
      const next={...latest.data} as SubjectData;
      if(result._tag==="Success"){next.lastSnapshotId=result.success.snapshotId;next.capturedAtMs=now;next.lastAction="snapshot_saved";next.pendingSnapshotId=null;
        next.archiveSnapshotIds=p.tier==="archive"?[...new Set([...(next.archiveSnapshotIds??[]),result.success.snapshotId])].slice(-8):[];}
      else {next.lastAction="snapshot_unavailable";}
      yield* db.updateSubject(logicalId,latest.revision,currentId,row.generation,next).pipe(Effect.catch(()=>Effect.succeed(0)));
      data.lastAction=next.lastAction;
      return {state:data.lastAction,logicalId,currentId};
    }
    if(!data.lossId||!["temporal","conflict"].includes(data.lastState??"")||p.mode==="alert")return {state:"watching",logicalId,currentId};
    if(!data.pendingOperationId){
      const budget=replacementBudget(p,data.replacementTimes,now);if(!budget.allowed)return {state:budget.reason,logicalId};
      data.pendingOperationId=continuityId(data.lossId,"replacement");data.replacementTimes=[...budget.recent,now];
      revision=yield* db.updateSubject(logicalId,revision,currentId,row.generation,data);
    }
    const operationId=data.pendingOperationId;
    const workflow=openBotLifecycle({...input,native:native.lifecycle});
    const request=yield* io(()=>workflow.request(operationId)).pipe(Effect.catch(e=>e instanceof ContinuityFailure&&e.code==="not_found"?io(()=>native.request(logicalId,currentId,operationId,data.lastSnapshotId,p)):Effect.fail(e)));
    const result=yield* io(()=>workflow.advance(request));
    const latest=yield* db.subject(logicalId);
    if(!latest||latest.currentId!==currentId||latest.generation!==row.generation)return {state:"superseded",operationId};
    const next={...latest.data} as SubjectData;
    if(result.phase==="active_with_handover"&&result.targetId){
      next.previousIds=[...new Set([...next.previousIds,currentId])].slice(-16);next.pendingOperationId=null;next.lossId=null;next.lossAtMs=null;next.lastState=null;next.lastSnapshotId=null;next.pendingSnapshotId=null;next.capturedAtMs=0;next.lastAction="successor_active";
      yield* db.updateSubject(logicalId,latest.revision,result.targetId,row.generation+1,next);
    }else{next.lastAction=String(result.phase);yield* db.updateSubject(logicalId,latest.revision,currentId,row.generation,next).pipe(Effect.catch(()=>Effect.succeed(0)));}
    return {state:result.phase,logicalId,operationId,targetId:result.targetId,blocked:result.blocked};
  });
  const handovers=()=>Effect.gen(function*(){
    const policy=continuityProtection(yield* io(native.policy));if(!policy.enabled)return {state:"off"};
    yield* db.initialize();const all=yield* db.list(128);let advanced=0;
    const eligible=all.filter(item=>item.kind==="replace"&&item.phase==="active_with_handover");
    for(let n=0;n<Math.min(4,eligible.length);n++){
      const item=eligible[(handoverOffset+n)%eligible.length]!;
      yield* io(()=>native.handover(String(item.operation_id))).pipe(Effect.catch(()=>Effect.succeed(undefined)));advanced++;
    }
    if(eligible.length)handoverOffset=(handoverOffset+advanced)%eligible.length;
    return {state:"observed",advanced};
  });
  const run=<A>(effect:Effect.Effect<A,CurrentStateFailure|ContinuityFailure>,signal?:AbortSignal)=>Effect.runPromise(effect,signal?{signal}:undefined);
  return {observe:(signal?:AbortSignal)=>run(observed(),signal),advance:(signal?:AbortSignal)=>run(advance(),signal),handovers:(signal?:AbortSignal)=>run(handovers(),signal),
    subjects:async()=>{const policy=continuityProtection(await native.policy());return {enabled:policy.enabled,subjects:await Promise.all(Object.keys(policy.bots).map(id=>run(db.subject(id))))};}};
}

/** Normal daemon-owned child fibers. No task survives shutdown; actual bounded
 * callbacks settle before a fiber closes. Construction never changes config. */
export function startPolicyBoundBotProtection(input:{durableRoot:string;read:()=>Promise<{enabled:boolean;scopeId:string|null}>;create:(scopeId:string)=>BotProtectionPort}){
  let current:ReturnType<typeof startBotProtectionWorker>|undefined,scopeId:string|undefined,closed=false,last="off";
  const tick=Effect.gen(function*(){
    const config=yield* io(input.read);
    if(!config.enabled){if(current){yield* io(()=>current!.close());current=undefined;}last="off";return;}
    if(current && config.scopeId!==scopeId){yield* io(()=>current!.close());current=undefined;last="scope_changed_restart_required";return;}
    if(current){last="running";return;}
    if(config.scopeId===null){last="scope_unavailable";return;}
    if(scopeId!==undefined&&scopeId!==config.scopeId){last="scope_changed_restart_required";return;}
    scopeId=config.scopeId;current=startBotProtectionWorker({durableRoot:input.durableRoot,scopeId,native:input.create(scopeId)});last="running";
  }).pipe(Effect.catch(()=>Effect.sync(()=>{last="unavailable";})));
  const fiber=Effect.runFork(Effect.scoped(Effect.gen(function*(){
    yield* Effect.addFinalizer(()=>current?io(()=>current!.close()).pipe(Effect.catch(()=>Effect.void)):Effect.void);
    yield* Effect.forever(Effect.gen(function*(){yield* tick;yield* Effect.sleep("10 seconds");}));
  })));
  return {status:()=>({state:last,scopeId:scopeId??null,closed,worker:current?.status()??null}),
    close:async()=>{if(!closed){closed=true;await Effect.runPromise(Fiber.interrupt(fiber));}}};
}
export function startBotProtectionWorker(input:ContinuityStoreInput & {native:BotProtectionPort}) {
  const controller=openBotProtection(input);let closed=false,last:Record<string,unknown>={state:"starting"};
  const loop=(name:string,work:()=>Promise<unknown>,ms:number)=>Effect.forever(Effect.gen(function*(){
    const result=yield* io(work).pipe(Effect.catch(()=>Effect.succeed({state:"unavailable"})));last={...last,[name]:result};yield* Effect.sleep(ms);
  }));
  const fiber=Effect.runFork(Effect.scoped(Effect.gen(function*(){
    yield* loop("observation",()=>controller.observe(),10000).pipe(Effect.forkScoped);
    yield* loop("advancement",()=>controller.advance(),10000).pipe(Effect.forkScoped);
    yield* loop("handover",()=>controller.handovers(),30000).pipe(Effect.forkScoped);
    yield* Effect.never;
  })));
  return {status:()=>({...last,closed}),close:async()=>{if(!closed){closed=true;await Effect.runPromise(Fiber.interrupt(fiber));}}};
}
