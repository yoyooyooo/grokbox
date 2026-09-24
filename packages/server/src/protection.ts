import { Effect } from "effect";
import { projectHandover } from "./handover.ts";
import { UUID, botIdFromRef, botRef, normalizeProtectionChange, protectionReference, protectionReferenceIdentity,
  ManagementClientError, type ProtectionOverview, type ProtectionBotView, type ProtectionOperation, type ProtectionSubject, type ProtectionSnapshot,
  type ProtectionSnapshotList, type ProtectionHandover, type ProtectionWorkerView, type ProtectionChangeRequest } from "@grokbox/client/contract";
import { ConfigError, configChangeFingerprint, type ConfigChange } from "@grokbox/runtime-kernel/config";
import { continuityProtection, botProtection, ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { openConfigStore, rootConfigLayout, readProtectionSubjects, readProtectionSnapshots, readProtectionHandover } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type ProtectionDomain = { root: string; installationId: string; status: () => ProtectionWorkerView; authorizeWrite: (signal: AbortSignal) => Promise<void> };
const failure = (error: unknown): HttpFailure => {
  if(error instanceof HttpFailure)return error;
  if(error instanceof ManagementClientError)return new HttpFailure(error.code==="wrong_installation"?409:400,error.code,error.message);
  if(error instanceof ConfigError && error.code==="config_idempotency_conflict")return new HttpFailure(409,"idempotency_conflict","The protection request UUID already names different input.");
  if(error instanceof ConfigError)return new HttpFailure(error.code==="config_commit_unknown"?409:error.code==="config_conflict"?409:503,
    error.code==="config_commit_unknown"?"operation_unknown":error.code==="config_conflict"?"revision_conflict":"source_unavailable","The protection policy or its original receipt could not be verified.");
  if(error instanceof ContinuityFailure)return new HttpFailure(error.code==="not_found"?404:error.code==="scope_mismatch"?409:503,
    error.code==="not_found"?"not_found":error.code==="scope_mismatch"?"source_changed":"source_unavailable","The original protection source is unavailable or belongs to another scope; no history was recreated.");
  return new HttpFailure(503,"source_unavailable","Protection information is unavailable; no source or identity was substituted.");
};
const io = <A>(work: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({try:work,catch:failure});
const invalid = () => new HttpFailure(400,"invalid_input","Use an exact protection target and its supported bounded query.");
const target = (d: ProtectionDomain, value: string) => value==="system"?"system":botIdFromRef(value,d.installationId);
const targetRef = (d: ProtectionDomain, id: string) => id==="system"?`protection-system:${d.installationId}`:botRef(d.installationId,id);
export const protectionOperationKey = (installationId: string, principalId: string, target: string, requestId: string) => sha256Text(canonicalJson(["protection-policy-v1",installationId,principalId,target,requestId]));
async function operation(d: ProtectionDomain, p: Principal, id: string, requestId: string): Promise<ProtectionOperation> {
  const key=protectionOperationKey(d.installationId,p.id,id,requestId), row=await openConfigStore(rootConfigLayout(d.root)).operation(key);
  if(!row)throw new HttpFailure(404,"not_found","No protection policy receipt exists for this original principal, target and request.");
  return {requestId,operationRef:`protection-operation:${d.installationId}:${key}`,targetRef:targetRef(d,id),
    state:row.phase==="committed"?"succeeded":"unknown",beforeRevision:row.beforeRevision,revision:row.phase==="committed"?row.afterRevision:null,
    application:"not-observed",nativeEffectsPerformed:false};
}
function projectSubject(d: ProtectionDomain, scopeId: string, row: Awaited<ReturnType<typeof readProtectionSubjects>>["subjects"][number]): ProtectionSubject {
  const now=Date.now(),at=row.observedAtMs;
  return {botRef:botRef(d.installationId,row.logicalId),currentBotRef:botRef(d.installationId,row.currentId),previousBotRefs:row.previousIds.map(id=>botRef(d.installationId,id)),
    generation:row.generation,revision:row.revision,ownership:row.ownership as ProtectionSubject["ownership"],observedAtMs:at,
    freshness:at===null?"not-observed":now>=at&&now-at<=90000?"fresh":"stale",lossId:row.lossId,lossAtMs:row.lossAtMs,
    lastSnapshotRef:row.lastSnapshotId?protectionReference("snapshot",d.installationId,scopeId,row.lastSnapshotId):null,capturedAtMs:row.capturedAtMs,
    pendingHandoverRef:row.pendingOperationId?protectionReference("handover",d.installationId,scopeId,row.pendingOperationId):null,
    handoverRefs:row.handoverOperationIds.map(id=>protectionReference("handover",d.installationId,scopeId,id)),handoverHistoryTruncated:row.handoverHistoryTruncated,lastAction:row.lastAction,
    pause:row.pause,eventExportPending:row.eventExportPending,eventExportDropped:row.eventExportDropped,notificationDelivery:"not-observed"};
}
async function overview(d: ProtectionDomain): Promise<ProtectionOverview> {
  const snapshot=await openConfigStore(rootConfigLayout(d.root)).read(), policy=continuityProtection(snapshot.document.runtime?.continuity);
  let history: Awaited<ReturnType<typeof readProtectionSubjects>>|undefined;
  try{history=await readProtectionSubjects(d.root);}catch{/* The configuration and running worker remain independently inspectable. */}
  return {revision:snapshot.revision,enabled:policy.enabled,intervalMs:policy.intervalMs,defaultPolicy:botProtection(),worker:d.status(),
    store:history?history.scopeId?"observed":"not-initialized":"unavailable",scopeId:history?.scopeId??null,
    subjects:history?.scopeId?history.subjects.map(row=>projectSubject(d,history.scopeId!,row)):[],hasMore:history?.hasMore??false,
    overrides:Object.entries(policy.bots).map(([id,policy])=>({botRef:botRef(d.installationId,id),policy})),currentOwnershipProven:false};
}
function snapshotView(d: ProtectionDomain, scopeId: string, row: Awaited<ReturnType<typeof readProtectionSnapshots>>["snapshots"][number]): ProtectionSnapshot {
  return {snapshotRef:protectionReference("snapshot",d.installationId,scopeId,row.id),botRef:botRef(d.installationId,row.botId),revision:row.revision,
    state:row.state as ProtectionSnapshot["state"],quality:row.quality,capturedAtMs:row.capturedAtMs,contentIncluded:false,nativeImportProven:false};
}
export function protectionApplication(d: ProtectionDomain, p: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function*(){
    yield* Effect.try({try:()=>{
      requireCapability(p,method==="POST"?"protection.write":url.pathname.startsWith("/v1/protection-operations/")?"operations.read":"protection.read");
      if(url.pathname!=="/v1/protection-snapshots"&&url.search)throw invalid();
    },catch:failure});
    if(method==="GET"&&url.pathname==="/v1/protection")return yield* io(()=>overview(d));
    const bot=/^\/v1\/protection\/bots\/([^/]+)$/.exec(url.pathname);
    if(method==="GET"&&bot)return yield* io(async()=>{
      const id=botIdFromRef(decodeURIComponent(bot[1]!),d.installationId),view=await overview(d),ref=botRef(d.installationId,id);
      const override=view.overrides.find(item=>item.botRef===ref);
      return {revision:view.revision,enabled:view.enabled,botRef:ref,policy:override?.policy??view.defaultPolicy,policySource:override?"override":"default",
        subject:view.subjects.find(row=>row.botRef===ref)??null,store:view.store,scopeId:view.scopeId,protectionApplied:"not-observed"} satisfies ProtectionBotView;
    });
    if(method==="GET"&&url.pathname==="/v1/protection-snapshots")return yield* io(async()=>{
      if([...url.searchParams.keys()].some(k=>!["bot","limit"].includes(k))||url.searchParams.getAll("bot").length!==1||url.searchParams.getAll("limit").length>1)throw invalid();
      const id=botIdFromRef(url.searchParams.get("bot")!,d.installationId),limit=Number(url.searchParams.get("limit")??20);
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid();
      const result=await readProtectionSnapshots(d.root,{botId:id,limit});
      return {botRef:botRef(d.installationId,id),scopeId:result.scopeId,snapshots:result.snapshots.map(row=>snapshotView(d,result.scopeId!,row)),hasMore:result.hasMore,coverage:"retained-metadata"} satisfies ProtectionSnapshotList;
    });
    const snapshot=/^\/v1\/protection-snapshots\/([^/]+)$/.exec(url.pathname);
    if(method==="GET"&&snapshot)return yield* io(async()=>{
      const ref=protectionReferenceIdentity(decodeURIComponent(snapshot[1]!),d.installationId,"snapshot");
      const result=await readProtectionSnapshots(d.root,{scopeId:ref.scopeId,snapshotId:ref.id,limit:1});
      if(!result.snapshots[0])throw new HttpFailure(404,"not_found","This retained snapshot metadata was not found.");
      return snapshotView(d,ref.scopeId,result.snapshots[0]);
    });
    const handover=/^\/v1\/protection-handovers\/([^/]+)$/.exec(url.pathname);
    if(method==="GET"&&handover)return yield* io(async()=>{
      const ref=protectionReferenceIdentity(decodeURIComponent(handover[1]!),d.installationId,"handover"),r=await readProtectionHandover(d.root,ref.scopeId,ref.id);
      return projectHandover(d.installationId,r);
    });
    const lookup=/^\/v1\/protection-operations\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if(method==="GET"&&lookup)return yield* io(async()=>{
      if(!UUID.test(lookup[2]!))throw invalid();return operation(d,p,target(d,decodeURIComponent(lookup[1]!)),lookup[2]!.toLowerCase());
    });
    if(method==="POST"&&url.pathname==="/v1/protection-changes") {
      const r=yield* Effect.try({try:()=>normalizeProtectionChange(input,d.installationId),catch:failure});
      const id=r.action==="system"?"system":botIdFromRef(r.botRef,d.installationId), key=protectionOperationKey(d.installationId,p.id,id,r.requestId);
      const command: ConfigChange={kind:"protection-settings",operationId:key,scope:"box",confirm:true,expectedRevision:r.expectedRevision,
        change:r.action==="system"?{action:"system",enabled:r.enabled}:r.action==="reset"?{action:"reset",agentId:id}:{action:"set",agentId:id,patch:r.patch}};
      const store=openConfigStore(rootConfigLayout(d.root)),old=yield* io(()=>store.operation(key));
      if(old&&old.fingerprint!==sha256Text(configChangeFingerprint(command)))return yield* Effect.fail(new HttpFailure(409,"idempotency_conflict","This protection request ID is bound to another policy change."));
      if(!old) {
        // Authorization is re-read at the local publication boundary; native
        // effects are left to the separate policy-bound background lifetime.
        yield* store.change(command,async()=>{
          await d.authorizeWrite(AbortSignal.timeout(5000));
          if(r.action==="set"){
            const records=await readProtectionSubjects(d.root),owner=records.subjects.find(row=>row.currentId===id&&row.logicalId!==id);
            if(owner)throw new HttpFailure(409,"protection_target_conflict","This successor is already controlled by an original protection subject. Use that explicit reference instead of starting a second controller.",{originalBotRef:botRef(d.installationId,owner.logicalId)});
          }
        }).pipe(Effect.mapError(failure));
      }
      return yield* io(()=>operation(d,p,id,r.requestId));
    }
    return yield* Effect.fail(new HttpFailure(404,"not_found","This protection endpoint is not supported."));
  });
}
