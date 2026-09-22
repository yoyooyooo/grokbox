import { UUID } from "./contract.ts";
import { JOB_STATES, jobIdentity, type JobView, type JobPolicyView, type JobLogPage, type JobCancelReceipt } from "./job-contract.ts";
import { record, exact, revision } from "./response-validation.ts";
const n=(v:unknown,min=0):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min;
const time=(v:unknown):v is number=>n(v,1)&&v<=8640000000000000;
const ref=(v:unknown,i:string)=>{try{return typeof v==="string"&&jobIdentity(v,i).ref===v;}catch{return false;}};
export function jobView(v:unknown,i:string):v is JobView{
  if(!record(v)||!exact(v,["version","jobRef","requestId","policyRevision","state","observation","createdAt","startedAt","finishedAt","cwd","command","output","runTimeoutMs","exitCode","signal","reason","cancelOperationId","logs","effectsReverted"])
    ||v.version!==1||!ref(v.jobRef,i)||typeof v.requestId!=="string"||!UUID.test(v.requestId)||!revision(v.policyRevision)
    ||!JOB_STATES.includes(v.state as never)||!['current-service','retained-record'].includes(v.observation as string)
    ||!time(v.createdAt)||v.startedAt!==null&&!time(v.startedAt)||v.finishedAt!==null&&!time(v.finishedAt)
    ||typeof v.cwd!=="string"||v.cwd.length>4096||!/^([a-z][a-z0-9-]{0,31}):\//.test(v.cwd)
    ||!record(v.command)||!exact(v.command,["executable","argumentCount","shell"])||typeof v.command.executable!=="string"||v.command.executable.length>64||!n(v.command.argumentCount)||v.command.argumentCount>255||typeof v.command.shell!=="boolean"
    ||!['capture','discard'].includes(v.output as string)||!n(v.runTimeoutMs,100)||v.runTimeoutMs>86400000
    ||v.exitCode!==null&&(!n(v.exitCode)||v.exitCode>255)||v.signal!==null&&(typeof v.signal!=="string"||!/^SIG[A-Z0-9]{1,16}$/.test(v.signal))
    ||v.reason!==null&&(typeof v.reason!=="string"||! /^[a-z][a-z0-9_]{0,79}$/.test(v.reason))
    ||v.cancelOperationId!==null&&(typeof v.cancelOperationId!=="string"||!UUID.test(v.cancelOperationId))
    ||!record(v.logs)||!exact(v.logs,["bytes","nextOffset","truncated"])||!n(v.logs.bytes)||v.logs.nextOffset!==v.logs.bytes||typeof v.logs.truncated!=="boolean"||v.effectsReverted!==false)return false;
  if(v.state==="succeeded"&&(v.exitCode!==0||v.finishedAt===null))return false;
  if(["queued","running"].includes(v.state as string)&&(v.finishedAt!==null||v.observation!=="current-service"))return false;
  return true;
}
export function jobPolicy(v:unknown):v is JobPolicyView{
  if(!record(v)||!exact(v,["state","revision","serviceGeneration","roots","defaultCwdRoot","executables","environment","shellAllowed","limits","filesystemSandbox"])
    ||!['ready','unconfigured','unavailable','restart-required'].includes(v.state as string)||typeof v.serviceGeneration!=="string"||!UUID.test(v.serviceGeneration)
    ||v.revision!==null&&!revision(v.revision)||v.filesystemSandbox!==false||typeof v.shellAllowed!=="boolean")return false;
  for(const k of ['roots','executables','environment']){const a=v[k];if(!Array.isArray(a)||a.length>256||a.some(s=>typeof s!=="string"||s.length>64)||new Set(a).size!==a.length)return false;}
  if(v.state!=="ready")return v.limits===null&&v.defaultCwdRoot===null;
  return revision(v.revision)&&typeof v.defaultCwdRoot==="string"&&(v.roots as string[]).includes(v.defaultCwdRoot)&&record(v.limits)
    &&exact(v.limits,["maxConcurrent","maxQueued","maxRuntimeMs","maxOutputBytes","safetyRecords"])
    &&n(v.limits.maxConcurrent,1)&&n(v.limits.maxQueued)&&n(v.limits.maxRuntimeMs,100)&&n(v.limits.maxOutputBytes,1)&&v.limits.safetyRecords===4096;
}
export function jobLogs(v:unknown,i:string,expectedRef:string,offset:number,maxBytes:number):v is JobLogPage{
  if(!record(v)||!exact(v,["jobRef","offset","nextOffset","state","complete","truncated","events"])||v.jobRef!==expectedRef||!ref(v.jobRef,i)
    ||v.offset!==offset||!n(v.nextOffset)||!JOB_STATES.includes(v.state as never)||typeof v.complete!=="boolean"||typeof v.truncated!=="boolean"||!Array.isArray(v.events)||v.events.length>128)return false;
  let next=offset,bytes=0;
  for(const e of v.events){
    if(!record(e)||!exact(e,["offset","nextOffset","stream","observedAt","bytes","contentBase64"])||e.offset!==next||!n(e.bytes,1)||e.bytes>65536||e.nextOffset!==next+e.bytes||!time(e.observedAt)
      ||!['stdout','stderr'].includes(e.stream as string)||typeof e.contentBase64!=="string"||e.contentBase64.length!==4*Math.ceil(e.bytes/3)
      ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.contentBase64))return false;
    const padding=e.contentBase64.endsWith('==')?2:e.contentBase64.endsWith('=')?1:0;
    if(e.contentBase64.length/4*3-padding!==e.bytes||btoa(atob(e.contentBase64))!==e.contentBase64)return false;
    next=e.nextOffset as number;bytes+=e.bytes;
  }
  return v.nextOffset===next&&bytes<=maxBytes&&(!v.complete||!['queued','running','unknown'].includes(v.state as string));
}
export function jobCancellation(v:unknown,i:string,expectedRef:string,requestId:string):v is JobCancelReceipt{
  if(!record(v)||!exact(v,["version","requestId","jobRef","state","cancelOperationId","job","effectsReverted"])||v.version!==1||v.requestId!==requestId||v.jobRef!==expectedRef
    ||v.cancelOperationId!==requestId||typeof v.cancelOperationId!=="string"||!UUID.test(v.cancelOperationId)||!jobView(v.job,i)||v.job.jobRef!==expectedRef||v.job.cancelOperationId!==v.cancelOperationId||v.effectsReverted!==false)return false;
  return v.state===(v.job.state==='unknown'||v.job.reason==='cancel_persistence_unknown'?'unknown':['queued','running'].includes(v.job.state)?'requested':'settled');
}
