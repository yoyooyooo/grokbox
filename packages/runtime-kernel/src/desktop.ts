/** Desktop observations and exact reclaim intent; not an OS process sandbox. */
export const MAIN_DISPLAY = 1;
export const DEFAULT_MIN_IDLE_MS = 600_000;
export const DESKTOP_POLICY = Object.freeze({ maxSeats: 128, maxBatch: 8, maxOperations: 2048, intervalMs: 60_000, stopTimeoutMs: 30_000 });
export type DesktopLaunchResources = { stopWindowPath?: string; floorAgentIds?: string[]; keepAgentIds?: string[]; minIdleMs?: number; pruneEnabled?: boolean };
export type DesktopBusyReason = "protected" | "dark" | "fresh-display" | "recent-transcript" | "grok" | "task" | "busy-marker" | "start-window" | "source-incomplete" | "ambiguous-seat";
export type DesktopRow = { display: number; agentId: string; lit: boolean; idle: boolean; protected: boolean; busyReason: DesktopBusyReason | null };
export type DesktopWorld = {
  complete: boolean; displayIdentities: Record<number,string>; nowMs: number;
  assignments: Record<string,number>; names: Record<string,string>; litDisplays: ReadonlySet<number>;
  displayStartedAtMs: Record<number,number>; transcriptWrittenAtMs: Record<string,number>;
  busyMarkers: ReadonlySet<number>; grokDisplays: ReadonlySet<number>; taskDisplays: ReadonlySet<number>; startWindowDisplays: ReadonlySet<number>;
};
export type DesktopPolicy = { minIdleMs: number; minDisplayAgeMs: number; floorAgentIds: readonly string[]; keepAgentIds: readonly string[] };
export type DesktopPruneOutcome = "planned" | "stopped" | "kept" | "raced" | "busy";
export type DesktopPruneRow = { display: number; agentId: string; outcome: DesktopPruneOutcome; busyReason: DesktopBusyReason | null };
export function classifyDesktop(world: DesktopWorld, policy: DesktopPolicy): DesktopRow[] {
  const keep=new Set([...policy.floorAgentIds,...policy.keepAgentIds].map(id=>id.toLowerCase()));
  const entries=Object.entries(world.assignments).filter(([,d])=>Number.isInteger(d)&&d>=1).sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0]));
  return entries.map(([agentId,display])=>{
    const lit=world.litDisplays.has(display),protectedSeat=display<=MAIN_DISPLAY||keep.has(agentId.toLowerCase());
    const busyReason:DesktopBusyReason|null=protectedSeat?"protected":!world.complete?"source-incomplete"
      :entries.filter(([,d])=>d===display).length!==1?"ambiguous-seat":!lit?"dark"
      :!DESKTOP_SHA.test(world.displayIdentities[display]??"")?"source-incomplete"
      :world.startWindowDisplays.has(display)?"start-window":world.busyMarkers.has(display)?"busy-marker"
      :world.grokDisplays.has(display)?"grok":world.taskDisplays.has(display)?"task"
      :world.nowMs-(world.displayStartedAtMs[display]??world.nowMs)<policy.minDisplayAgeMs?"fresh-display"
      :world.nowMs-(world.transcriptWrittenAtMs[agentId]??world.nowMs)<policy.minIdleMs?"recent-transcript":null;
    return {display,agentId,lit,idle:lit&&!protectedSeat&&busyReason===null,protected:protectedSeat,busyReason};
  });
}
export function displayFromEnviron(environ:string):number|undefined {
  const found=environ.split("\0").flatMap(part=>{const match=/^DISPLAY=:([0-9]+)(?:\.0)?$/.exec(part);return match?[Number(match[1])]:[];});
  return found.length===1&&Number.isSafeInteger(found[0])&&found[0]!>=1?found[0]:undefined;
}
export function inspectDesktopProc(cmdline:string):{grok:boolean;task:boolean;startWindow:number|undefined}{
  const args=cmdline.split("\0").filter(Boolean),text=args.join(" ");let startWindow:number|undefined;
  for(let i=0;i<args.length;i++)if(/(?:^|\/)start-window(?:\.sh)?$/.test(args[i]!)){
    const n=/^[0-9]+$/.test(args[i+1]??"")?Number(args[i+1]):NaN;if(Number.isSafeInteger(n)&&n>=2)startWindow=n;break;
  }
  return {grok:args.some(arg=>/(?:^|\/)grok$/.test(arg)),task:/\bTask\(/.test(text),startWindow};
}
export function resolveDesktopAgent(ref:string,world:DesktopWorld):string|undefined {
  const value=ref.trim();if(!value)return undefined;if(world.assignments[value]!==undefined)return value;
  const ids=Object.entries(world.names).filter(([,name])=>name.toLowerCase()===value.toLowerCase()).map(([id])=>id);
  return ids.length===1?ids[0]:undefined;
}
export const DESKTOP_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DESKTOP_SHA=/^[a-f0-9]{64}$/;
export type DesktopView = { installationId:string; state:"ready"|"unavailable"; observedAtMs:number; revision:string|null; configRevision:string|null;
  canPrune:boolean; automatic:boolean; worker:"waiting"|"working"|"unavailable"|"stopped"; keepAgentIds:string[]; floorAgentIds:string[]; minIdleMs:number;
  displays:Array<DesktopRow & {identity:string|null}>; coverage:"local-desktop-observation"; atomicSeatLease:false };
export type DesktopPruneRequest = {requestId:string;expectedRevision:string;confirmed:true};
export type DesktopPolicyRequest = {requestId:string;expectedRevision:string;confirmed:true}&({action:"keep";agentIds:string[]}|{action:"idle-reclaim";enabled:boolean;minIdleMs:number});
export type DesktopPolicyReceipt = {version:1;requestId:string;state:"succeeded"|"unknown";beforeRevision:string;revision:string;changedPaths:string[];application:"not-observed"};
export type DesktopOperation = {version:1;installationId:string;requestId:string;operationRef:string;origin:"manual"|"automatic";expectedRevision:string;
  state:"succeeded"|"refused"|"unknown";acceptedAtMs:number;settledAtMs:number|null;
  rows:Array<{display:number;agentId:string;identity:string;state:"planned"|"dispatching"|"stopped"|"refused"|"unknown";observation:"not-observed"|"display-dark"}>;
  atomicSeatLease:false;botDeleted:false};
export class DesktopError extends Error {
  constructor(readonly code:"invalid_input"|"source_unavailable"|"revision_conflict"|"operation_unknown"|"idempotency_conflict"|"permission_denied"|"not_found"|"store_full",message:string){super(message);this.name="DesktopError";}
}
const invalid=():never=>{throw new DesktopError("invalid_input","Desktop actions require exact bounded data, a reviewed revision and the original request UUID.");};
export function desktopData(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return invalid();
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=="string"||!keys.includes(k)))return invalid();
  for(const key of own){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!("value"in d)||!d.enumerable)return invalid();}
  return value as Record<string,unknown>;
}
function identity(r:Record<string,unknown>){if(typeof r.requestId!=="string"||!DESKTOP_UUID.test(r.requestId)||typeof r.expectedRevision!=="string"||!DESKTOP_SHA.test(r.expectedRevision)||r.confirmed!==true)return invalid();return {requestId:r.requestId.toLowerCase(),expectedRevision:r.expectedRevision,confirmed:true as const};}
export function normalizeDesktopPrune(value:unknown):DesktopPruneRequest{return identity(desktopData(value,["requestId","expectedRevision","confirmed"]));}
export function normalizeDesktopPolicy(value:unknown):DesktopPolicyRequest{
  if(!value||typeof value!=="object")return invalid();const discriminator=Object.getOwnPropertyDescriptor(value,"action");if(!discriminator||!("value"in discriminator))return invalid();
  const action=discriminator.value;
  const r=desktopData(value,["requestId","expectedRevision","confirmed","action",...(action==="keep"?["agentIds"]:action==="idle-reclaim"?["enabled","minIdleMs"]:[])]),base=identity(r);
  if(action==="keep"){
    const a=r.agentIds;if(!Array.isArray(a)||a.length>128||Object.getPrototypeOf(a)!==Array.prototype||Reflect.ownKeys(a).length!==a.length+1)return invalid();
    for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!("value"in d)||typeof d.value!=="string"||!DESKTOP_UUID.test(d.value))return invalid();}
    const agentIds=(a as string[]).map(v=>v.toLowerCase()).sort();if(new Set(agentIds).size!==agentIds.length)return invalid();return {...base,action,agentIds};
  }
  if(action!=="idle-reclaim"||typeof r.enabled!=="boolean"||!Number.isSafeInteger(r.minIdleMs)||Number(r.minIdleMs)<600000||Number(r.minIdleMs)>86400000)return invalid();
  return {...base,action,enabled:r.enabled,minIdleMs:Number(r.minIdleMs)};
}
export function validDesktopOperation(value:unknown,installation:string,requestId?:string):value is DesktopOperation {
  try{const r=desktopData(value,["version","installationId","requestId","operationRef","origin","expectedRevision","state","acceptedAtMs","settledAtMs","rows","atomicSeatLease","botDeleted"]);
    if(r.version!==1||r.installationId!==installation||typeof r.requestId!=="string"||!DESKTOP_UUID.test(r.requestId)||requestId!==undefined&&r.requestId!==requestId||typeof r.operationRef!=="string"||!r.operationRef.startsWith(`desktop-operation:${installation}:`)||!DESKTOP_SHA.test(r.operationRef.split(":")[2]??"")||r.operationRef.split(":").length!==3
      ||!["manual","automatic"].includes(r.origin as string)||typeof r.expectedRevision!=="string"||!DESKTOP_SHA.test(r.expectedRevision)||!["succeeded","refused","unknown"].includes(r.state as string)||!Number.isSafeInteger(r.acceptedAtMs)||Number(r.acceptedAtMs)<1||r.atomicSeatLease!==false||r.botDeleted!==false||!Array.isArray(r.rows)||r.rows.length>DESKTOP_POLICY.maxBatch)return false;
    if(r.settledAtMs!==null&&(!Number.isSafeInteger(r.settledAtMs)||Number(r.settledAtMs)<Number(r.acceptedAtMs))||r.state!=="unknown"&&r.settledAtMs===null)return false;
    const ids=new Set<number>(),agents=new Set<string>();for(const v of r.rows){const x=desktopData(v,["display","agentId","identity","state","observation"]);
      if(!Number.isSafeInteger(x.display)||Number(x.display)<=1||Number(x.display)>65535||ids.has(Number(x.display))||typeof x.agentId!=="string"||!DESKTOP_UUID.test(x.agentId)||agents.has(x.agentId)||typeof x.identity!=="string"||!DESKTOP_SHA.test(x.identity)||!["planned","dispatching","stopped","refused","unknown"].includes(x.state as string)||!(["not-observed","display-dark"].includes(x.observation as string))||(x.state==="stopped")!==(x.observation==="display-dark"))return false;ids.add(Number(x.display));agents.add(x.agentId as string);}
    if(r.state==="succeeded"&&r.rows.some((x:any)=>x.state!=="stopped")||r.state==="refused"&&r.rows.some((x:any)=>!["stopped","refused"].includes(x.state)))return false;
    return true;
  }catch{return false;}
}
