import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ConfigError } from "@grokbox/runtime-kernel/config";
import { DESKTOP_POLICY, DESKTOP_UUID, DesktopError, normalizeDesktopPrune, normalizeDesktopPolicy, type DesktopView, type DesktopPruneRequest, type DesktopPolicyRequest, type DesktopPolicyReceipt, type DesktopOperation } from "@grokbox/runtime-kernel/desktop";
import { DesktopManager, HostResourceError, acquireAdvisoryGate, openConfigStore, rootConfigLayout, readInstallation, openDesktopStore, desktopOperationKey, type DesktopIo } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import type { Capability } from "@grokbox/client/contract";
type Authorize=(signal:AbortSignal,capability:Capability)=>Promise<void>;
const failure=(e:unknown):HttpFailure=>{
  if(e instanceof HttpFailure)return e;
  if(e instanceof DesktopError)return new HttpFailure(e.code==="invalid_input"?400:e.code==="permission_denied"?403:e.code==="not_found"?404:e.code==="store_full"?507:e.code==="source_unavailable"?503:409,e.code,e.message);
  if(e instanceof ConfigError)return new HttpFailure(409,e.code==="config_conflict"?"revision_conflict":e.code==="config_commit_unknown"?"operation_unknown":"source_unavailable","The original desktop configuration could not be verified. No replacement writer was selected.");
  return new HttpFailure(503,"source_unavailable","The desktop source or original action is unavailable; no empty-success result was fabricated.");
};
const io=<A>(run:()=>Promise<A>)=>Effect.tryPromise({try:run,catch:failure});
function policyId(installation:string,principal:string,requestId:string){const b=createHash("sha256").update(canonicalJson(["desktop-policy-v1",installation,principal,requestId])).digest();b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=b.subarray(0,16).toString("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export type DesktopTestPorts={io?:DesktopIo;intervalMs?:number;afterClaim?:()=>Promise<void>;afterDispatchClaim?:()=>Promise<void>};
/** The management Scope owns the original classifier/helper manager. Both
 * automatic and manual reclaim enter the same durable per-display program. */
export class DesktopService {
  private manager?:DesktopManager;private gate?:Awaited<ReturnType<typeof acquireAdvisoryGate>>;
  private readonly pending=new Set<Promise<unknown>>();private readonly lifetime=new AbortController();
  private stopped=false;private closing?:Promise<void>;private worker:DesktopView["worker"]="waiting";
  private securityDigest: string | undefined;
  private constructor(readonly root:string,readonly installationId:string,private readonly test:DesktopTestPorts){}
  static async acquire(root:string,installationId:string,test:DesktopTestPorts={}){
    const s=new DesktopService(root,installationId,test);
    try{const installation=await readInstallation(root);if(!installation||installation.installationId!==installationId)throw new Error();
      s.gate=await acquireAdvisoryGate(join(root,"run/desktop.owner.gate"));
      if(!s.gate)throw new Error();
      s.securityDigest = sha256Text(canonicalJson(installation.desktop ?? null));
      s.manager=await DesktopManager.create(root,Date.now,installation.desktop,test.io,test.intervalMs??DESKTOP_POLICY.intervalMs);
      s.manager.startAutomatic(()=>s.cycle());
    }catch{await s.manager?.close();s.manager=undefined;await s.gate?.release();s.gate=undefined;s.worker="unavailable";}
    return s;
  }
  track<A>(action:()=>Promise<A>):Promise<A>{if(this.stopped)return Promise.reject(new HttpFailure(503,"unavailable","Desktop service is stopping."));const work=Promise.resolve().then(action);this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>undefined);return work;}
  async status():Promise<DesktopView>{
    const empty:DesktopView={installationId:this.installationId,state:"unavailable",observedAtMs:Date.now(),revision:null,configRevision:null,canPrune:false,automatic:false,worker:this.stopped?"stopped":this.worker,keepAgentIds:[],floorAgentIds:[],minIdleMs:600000,displays:[],coverage:"local-desktop-observation",atomicSeatLease:false};
    const store=openConfigStore(rootConfigLayout(this.root));
    try{const first=await store.read();empty.configRevision=first.revision;empty.automatic=first.document.desktop?.idleReclaim?.enabled===true;empty.keepAgentIds=[...(first.document.desktop?.keepAgentIds??[])];empty.minIdleMs=first.document.desktop?.idleReclaim?.minIdleMs??600000;
      const installation=await readInstallation(this.root);empty.floorAgentIds=[...(installation?.desktop?.floorAgentIds??[])];
      if(!this.manager||this.stopped || installation?.installationId !== this.installationId || sha256Text(canonicalJson(installation.desktop ?? null)) !== this.securityDigest)return empty;
      const observed=await this.manager.status();if((await store.read()).revision!==first.revision)throw new Error();
      const displays=observed.displays.map(row=>({...row,identity:observed.displayIdentities[row.display]??null}));
      const revision=sha256Text(canonicalJson([this.installationId,first.revision,displays,observed.floorAgentIds,this.manager.canReap]));
      return {...empty,state:observed.complete?"ready":"unavailable",observedAtMs:observed.observedAtMs,revision:observed.complete?revision:null,canPrune:observed.complete&&this.manager.canReap,displays};
    }catch{return empty;}
  }
  async operation(requestId:string,principal:Principal){
    if(!DESKTOP_UUID.test(requestId))throw new DesktopError("invalid_input","Use the original request UUID.");
    const record=await openDesktopStore(this.root,this.installationId).read(desktopOperationKey(this.installationId,principal.id,requestId));
    if(!record)throw new DesktopError("not_found","No original desktop operation was found for this principal.");return record.receipt;
  }
  private async checkReviewedPolicy(configRevision:string|null):Promise<void>{
    this.lifetime.signal.throwIfAborted();
    const installation=await readInstallation(this.root);
    if(installation?.installationId!==this.installationId||sha256Text(canonicalJson(installation.desktop??null))!==this.securityDigest
      ||(await openConfigStore(rootConfigLayout(this.root)).read()).revision!==configRevision) {
      throw new DesktopError("revision_conflict","The reviewed desktop policy or installation protection changed before helper dispatch.");
    }
    this.lifetime.signal.throwIfAborted();
  }
  async prune(request:DesktopPruneRequest,principal:Principal,authorize:Authorize,origin:"manual"|"automatic"="manual"):Promise<DesktopOperation>{
    const store=openDesktopStore(this.root,this.installationId),key=desktopOperationKey(this.installationId,principal.id,request.requestId),digest=sha256Text(canonicalJson([request,origin]));
    const prior=await store.read(key);if(prior){if(prior.digest!==digest)throw new DesktopError("idempotency_conflict","The desktop request UUID was reused with a different review.");return prior.receipt;}
    const view=await this.status();if(!this.manager||!this.gate||!view.canPrune||view.revision!==request.expectedRevision)throw new DesktopError("revision_conflict","Review current desktop identity, activity and protection before reclaim.");
    const rows:DesktopOperation["rows"]=view.displays.filter(row=>row.idle&&row.identity).slice(0,DESKTOP_POLICY.maxBatch).map(row=>({display:row.display,agentId:row.agentId,identity:row.identity!,state:"planned",observation:"not-observed"}));
    const initial:DesktopOperation={version:1,installationId:this.installationId,requestId:request.requestId,operationRef:`desktop-operation:${this.installationId}:${key}`,origin,expectedRevision:request.expectedRevision,state:"unknown",acceptedAtMs:Date.now(),settledAtMs:null,rows,atomicSeatLease:false,botDeleted:false};
    await authorize(this.lifetime.signal,"desktop.prune");const claim=await store.reserve(principal.id,digest,initial);if(!claim.created)return claim.receipt;
    try { await this.test.afterClaim?.(); } catch { throw new DesktopError("operation_unknown", "The original desktop claim was retained without a verified dispatch."); }
    let receipt=structuredClone(initial);
    const publish=async(next:DesktopOperation)=>{receipt=await store.publish(principal.id,next);};
    try{await this.manager.reclaim(rows,{
      before:async(row)=>{
        this.lifetime.signal.throwIfAborted();await authorize(this.lifetime.signal,"desktop.prune");
        await this.checkReviewedPolicy(view.configRevision);
        await publish({...receipt,rows:receipt.rows.map(x=>x.display===row.display?{...x,state:"dispatching"}:x)});
        await this.test.afterDispatchClaim?.();this.lifetime.signal.throwIfAborted();await authorize(this.lifetime.signal,"desktop.prune");
        await this.checkReviewedPolicy(view.configRevision);
      },
      after:async(row,outcome)=>{await publish({...receipt,rows:receipt.rows.map(x=>x.display===row.display?{...x,state:outcome,observation:outcome==="stopped"?"display-dark":"not-observed"}:x)});},
    },origin==="automatic");
      const state=receipt.rows.some(r=>["unknown","dispatching","planned"].includes(r.state))?"unknown":receipt.rows.some(r=>r.state==="refused")?"refused":"succeeded";
      await publish({...receipt,state,settledAtMs:Date.now()});return receipt;
    }catch{throw new DesktopError("operation_unknown","The original desktop action has no complete settlement. Query it; do not repeat a stop.");}
  }
  async policyOperation(requestId:string,principal:Principal):Promise<DesktopPolicyReceipt>{
    if(!DESKTOP_UUID.test(requestId))throw new DesktopError("invalid_input","Invalid original policy request.");
    const value=await openConfigStore(rootConfigLayout(this.root)).operation(policyId(this.installationId,principal.id,requestId));
    if(!value)throw new DesktopError("not_found","The original desktop policy receipt is absent.");
    if(value.result.changedPaths.some(p=>!p.startsWith("/desktop")&&!p.startsWith("desktop")))throw new DesktopError("source_unavailable","The policy receipt is not a desktop-domain operation.");
    return {version:1,requestId,state:value.phase==="committed"?"succeeded":"unknown",beforeRevision:value.beforeRevision,revision:value.afterRevision,changedPaths:value.result.changedPaths,application:"not-observed"};
  }
  changePolicy(request:DesktopPolicyRequest,principal:Principal,authorize:Authorize){
    const s=this;return Effect.gen(function*(){
      const command={operationId:policyId(s.installationId,principal.id,request.requestId),scope:"box" as const,kind:"set" as const,path:request.action==="keep"?"desktop.keepAgentIds":"desktop.idleReclaim",value:request.action==="keep"?request.agentIds:{enabled:request.enabled,minIdleMs:request.minIdleMs},expectedRevision:request.expectedRevision,confirm:true,replaceArrays:request.action==="keep"};
      yield* openConfigStore(rootConfigLayout(s.root)).change(command,()=>authorize(s.lifetime.signal,"desktop.write"));
      return yield* io(()=>s.policyOperation(request.requestId,principal));
    }).pipe(Effect.mapError(failure));
  }
  private async cycle(){
    if(this.stopped)return;this.worker="working";
    try{await this.manager?.refreshPreferences(true);const config=await openConfigStore(rootConfigLayout(this.root)).read();if(config.document.desktop?.idleReclaim?.enabled!==true){this.worker="waiting";return;}
      const view=await this.status();if(view.state!=="ready"||!view.canPrune){this.worker="unavailable";return;}
      if(view.displays.some(row=>row.idle))await this.prune({requestId:policyId(this.installationId,"system:desktop",view.revision!),expectedRevision:view.revision!,confirmed:true},{id:"system:desktop",capabilities:[]},async(signal)=>{signal.throwIfAborted();if((await openConfigStore(rootConfigLayout(this.root)).read()).document.desktop?.idleReclaim?.enabled!==true)throw new DesktopError("permission_denied","Automatic desktop reclaim is no longer enabled.");},"automatic");
      this.worker="waiting";
    }catch{this.worker="unavailable";}
  }
  close(){if(this.closing)return this.closing;this.stopped=true;this.lifetime.abort();this.worker="stopped";
    return this.closing=(async()=>{try{const closing=this.manager?.close();await Promise.allSettled([...this.pending]);await closing;}finally{await this.gate?.release();}})();
  }
}
export type DesktopDomain={service:DesktopService;authorize:Authorize};
export function desktopApplication(d:DesktopDomain,p:Principal,method:string,url:URL,input?:unknown){return Effect.gen(function*(){
  const path=url.pathname,policy=path.includes("policy"),operation=path.includes("operations"),cap:Capability=method==="GET"?operation?"operations.read":"desktop.read":policy?"desktop.write":"desktop.prune";
  yield* Effect.try({try:()=>{requireCapability(p,cap);if(url.search)throw new HttpFailure(400,"invalid_input","Desktop endpoints do not accept query parameters.");},catch:failure});
  if(method==="GET"&&path==="/v1/desktop")return yield* io(()=>d.service.status());
  const match=/^\/v1\/desktop-(policy-)?operations\/([a-f0-9-]{36})$/.exec(path);
  if(method==="GET"&&match)return yield* io<DesktopOperation|DesktopPolicyReceipt>(()=>match[1]?d.service.policyOperation(match[2]!,p):d.service.operation(match[2]!,p));
  if(method==="POST"&&path==="/v1/desktop-policy-changes") {
    const request = yield* Effect.try({ try: () => normalizeDesktopPolicy(input), catch: failure });
    return yield* d.service.changePolicy(request,p,d.authorize);
  }
  if(method==="POST"&&path==="/v1/desktop-prunes") {
    const request = yield* Effect.try({ try: () => normalizeDesktopPrune(input), catch: failure });
    return yield* io(()=>d.service.track(()=>d.service.prune(request,p,d.authorize)));
  }
  return yield* Effect.fail(new HttpFailure(404,"not_found","Unsupported desktop endpoint."));
});}
