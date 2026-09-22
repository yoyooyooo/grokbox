import { ManagementClientError, UUID } from "./contract.ts";

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "unknown"] as const;
export type JobState = typeof JOB_STATES[number];
export type JobStart = { requestId: string; expectedRevision: string; confirmed: true; argv: string[];
  environment: Record<string,string>; cwd?: string; runTimeoutMs: number; output: "capture" | "discard"; shell: boolean };
export type JobCancel = { jobRef: string; requestId: string; confirmed: true };
export type JobPolicyView = { state: "ready" | "unconfigured" | "unavailable" | "restart-required"; revision: string | null;
  serviceGeneration: string; roots: string[]; defaultCwdRoot: string | null; executables: string[]; environment: string[]; shellAllowed: boolean;
  limits: { maxConcurrent: number; maxQueued: number; maxRuntimeMs: number; maxOutputBytes: number; safetyRecords: 4096 } | null; filesystemSandbox: false };
export type JobView = { version: 1; jobRef: string; requestId: string; policyRevision: string; state: JobState;
  observation: "current-service" | "retained-record"; createdAt: number; startedAt: number | null; finishedAt: number | null;
  cwd: string; command: { executable: string; argumentCount: number; shell: boolean }; output: "capture" | "discard"; runTimeoutMs: number;
  exitCode: number | null; signal: string | null; reason: string | null; cancelOperationId: string | null;
  logs: { bytes: number; nextOffset: number; truncated: boolean }; effectsReverted: false };
export type JobPage = { jobs: JobView[]; nextCursor: string | null; coverage: "retained-principal-records" };
export type JobLogPage = { jobRef: string; offset: number; nextOffset: number; state: JobState; complete: boolean; truncated: boolean;
  events: Array<{ offset: number; nextOffset: number; stream: "stdout" | "stderr"; observedAt: number; bytes: number; contentBase64: string }> };
export type JobCancelReceipt = { version: 1; requestId: string; jobRef: string; state: "requested" | "settled" | "unknown";
  cancelOperationId: string; job: JobView; effectsReverted: false };
const fail = (): never => { throw new ManagementClientError("invalid_input", "Job input must be explicit bounded data; no executable objects, implicit shell or arbitrary environment expansion."); };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function object(value: unknown, required: string[], optional: string[] = []): Record<string,unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return fail();
  const keys=Reflect.ownKeys(value), allowed=[...required,...optional];
  if(keys.some(k=>typeof k!=="string"||!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k)))return fail();
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!("value" in d)||!d.enumerable)return fail();}
  return value as Record<string,unknown>;
}
const text = (v: unknown, max: number): v is string => typeof v === "string" && !v.includes("\0") && new TextEncoder().encode(v).length<=max;
function strings(v:unknown,max:number,size:number):string[]{
  if(!Array.isArray(v)||v.length<1||v.length>max||Object.getPrototypeOf(v)!==Array.prototype||Reflect.ownKeys(v).length!==v.length+1)return fail();
  for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!("value"in d)||!text(d.value,size))return fail();}
  return [...v] as string[];
}
export function jobIdentity(ref: string, installationId: string) {
  const parts=typeof ref==="string"?ref.split(":"):[];
  if(!UUID.test(installationId??"")||parts.length!==3||parts[0]!=="job"||!UUID.test(parts[1]!)||!UUID.test(parts[2]!))return fail();
  if(parts[1]!.toLowerCase()!==installationId.toLowerCase())throw new ManagementClientError("wrong_installation","The Job belongs to another installation.");
  return {id:parts[2]!.toLowerCase(),ref:`job:${installationId.toLowerCase()}:${parts[2]!.toLowerCase()}`};
}
export function normalizeJobStart(input: unknown): JobStart {
  const v=object(input,["requestId","expectedRevision","confirmed","argv","runTimeoutMs"],["environment","cwd","output","shell"]);
  if(typeof v.requestId!=="string"||!UUID.test(v.requestId)||!hash(v.expectedRevision)||v.confirmed!==true
    ||!Number.isSafeInteger(v.runTimeoutMs)||Number(v.runTimeoutMs)<100||Number(v.runTimeoutMs)>86400000
    ||v.cwd!==undefined&&(!text(v.cwd,4096)||!/^([a-z][a-z0-9-]{0,31}):\//.test(v.cwd))
    ||v.output!==undefined&&v.output!=="capture"&&v.output!=="discard"||v.shell!==undefined&&typeof v.shell!=="boolean")return fail();
  const argv=strings(v.argv,256,32768);if(argv.reduce((n,s)=>n+new TextEncoder().encode(s).length,0)>32768||!argv[0]||v.shell===true&&argv.length!==1)return fail();
  const environment:Record<string,string>={};
  if(v.environment!==undefined){
    if(!v.environment||typeof v.environment!=="object")return fail();
    const env=object(v.environment,[],Object.keys(v.environment));if(Object.keys(env).length>32)return fail();
    for(const [key,value]of Object.entries(env)) {if(!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key)||!text(value,8192))return fail();environment[key]=value;}
    if(new TextEncoder().encode(JSON.stringify(environment)).length>16384)return fail();
  }
  return {requestId:v.requestId.toLowerCase(),expectedRevision:v.expectedRevision,confirmed:true,argv,environment,
    ...(v.cwd===undefined?{}:{cwd:v.cwd as string}),runTimeoutMs:Number(v.runTimeoutMs),output:v.output==="discard"?"discard":"capture",shell:v.shell===true};
}
export function normalizeJobCancel(input:unknown,installationId:string):JobCancel{
  const v=object(input,["jobRef","requestId","confirmed"]);
  if(typeof v.requestId!=="string"||!UUID.test(v.requestId)||v.confirmed!==true)return fail();
  return {jobRef:jobIdentity(v.jobRef as string,installationId).ref,requestId:v.requestId.toLowerCase(),confirmed:true};
}
