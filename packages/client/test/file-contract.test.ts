import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { ManagementClient, normalizeFileChange, fileReference, fileIdentity, FILE_POLICY, type FileChange, type FileOperation } from "../src/client.ts";

const I="11111111-1111-4111-8111-111111111111",binding="a".repeat(64),ref=fileReference(I,binding,"files","note.txt"),generation=randomUUID();
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
const request=():FileChange=>({action:"write",requestId:randomUUID(),ref,expectedRevision:null,confirmed:true,content:"x"});
const receipt=(r:FileChange):FileOperation=>({version:1,requestId:r.requestId,operationRef:`file-operation:${I}:${"b".repeat(64)}`,ref:r.ref,action:r.action,serviceGeneration:generation,
  expectedRevision:r.expectedRevision,state:"succeeded",acceptedAtMs:1,settledAtMs:2,result:{revision:digest("x"),size:1,kind:"file",recoverable:false},externalCompareAndSwap:false,indexAdoption:"not-observed"});
function client(value:()=>unknown,error=false){
  let calls=0;
  const api=new ManagementClient({baseUrl:"http://127.0.0.1:3333",installationId:I,fetch:Object.assign(async()=>{calls++;return Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:!error,...(error?{error:{code:"file_change_refused",message:"Original refusal",details:{operation:value()}}}:{data:value()})},{status:error?409:200});},{preconnect:()=>undefined}) as typeof fetch});
  return {api,calls:()=>calls};
}
test("file changes validate own data before reading a discriminator, credentials or transport",async()=>{
  let getters=0;const r=request(),f=client(()=>null);
  const getter={...r};Object.defineProperty(getter,"action",{enumerable:true,get(){getters++;return "write";}});
  const hidden={...r};Object.defineProperty(hidden,"extra",{enumerable:false,value:true});
  const symbol={...r,[Symbol("hidden")]:true},inherited=Object.assign(Object.create({action:"write"}),r);
  for(const v of [getter,hidden,symbol,inherited,{...r,url:"https://arbitrary.invalid"},{...r,confirmed:false},{...r,content:"\ud800"}])await expect(f.api.changeFile(v as never)).rejects.toMatchObject({code:"invalid_input"});
  expect(getters).toBe(0);expect(f.calls()).toBe(0);
  for(const path of ["../escape","a//b","a/./b","a\\b","a\0b"] )expect(()=>fileReference(I,binding,"files",path)).toThrow();
  expect(()=>fileIdentity(ref.replace(I,generation),I)).toThrow();
  expect(()=>normalizeFileChange({...r,action:"upload",content:undefined,size:FILE_POLICY.maxBytes+1,sha256:digest("x")},I)).toThrow();
});
test("request identity and bytes are captured before credential resolution; a lost reply is never retried",async()=>{
  let release!:(v:string)=>void,submitted:any,calls=0;
  const r=request(),original=structuredClone(r),api=new ManagementClient({baseUrl:"http://127.0.0.1:3333",installationId:I,credential:()=>new Promise(resolve=>{release=resolve;}),fetch:Object.assign(async(_u:unknown,init?:RequestInit)=>{calls++;submitted=JSON.parse(String(init?.body));throw Error("lost");},{preconnect:()=>undefined}) as typeof fetch});
  const pending=api.changeFile(r);for(let n=0;!release&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,1));
  r.requestId=randomUUID();if(r.action==="write")r.content="changed";release("synthetic");
  await expect(pending).rejects.toMatchObject({code:"operation_unknown",details:{requestId:original.requestId,lookupPath:`/v1/file-operations/${original.requestId}`}});
  expect(submitted).toEqual(original);expect(calls).toBe(1);
});
for(const refused of [false,true])test(`file mutation ${refused?"refusal":"success"} validates the original scoped target and result`,async()=>{
  const r=request(),valid=refused?{...receipt(r),state:"refused" as const,result:null}:receipt(r);
  for(const patch of [{ref:fileReference(I,binding,"files","other.txt")},{requestId:randomUUID()},{action:"delete"},{serviceGeneration:"bad"},{expectedRevision:digest("other")},{state:"succeeded",result:{revision:digest("other"),size:1,kind:"file",recoverable:false}},{body:"private"}]){
    const f=client(()=>({...valid,...patch}),refused);await expect(f.api.changeFile(r)).rejects.toMatchObject({code:"operation_unknown"});expect(f.calls()).toBe(1);
  }
  if(refused)await expect(client(()=>valid,true).api.changeFile(r)).rejects.toMatchObject({code:"file_change_refused"});
  else expect((await client(()=>valid).api.changeFile(r)).data).toEqual(valid);
});
test("direct content checks canonical base64 and its actual SHA-256 before exposing bytes",async()=>{
  const good={ref,size:1,sha256:digest("x"),contentBase64:"eA==",encoding:"base64" as const};expect((await client(()=>good).api.readFile(ref)).data).toEqual(good);
  for(const patch of [{contentBase64:"eB=="},{sha256:digest("other")},{size:2},{ref:fileReference(I,binding,"files","other")},{encoding:"utf8"},{credential:"private"}])await expect(client(()=>({...good,...patch})).api.readFile(ref)).rejects.toMatchObject({code:"protocol_error"});
});
test("upload opening binds the same owner generation, size and hash as its original durable operation",async()=>{
  const r:FileChange={action:"upload",requestId:randomUUID(),ref,expectedRevision:null,confirmed:true,size:1,sha256:digest("x")};
  const operation={...receipt(r),state:"unknown" as const,settledAtMs:null,result:null},good={requestId:r.requestId,ref,generation,chunkBytes:32768 as const,chunks:1,size:1,sha256:digest("x"),operation};
  expect((await client(()=>good).api.changeFile(r)).data).toEqual(good);
  for(const patch of [{generation:randomUUID()},{size:2},{sha256:digest("other")},{chunkBytes:65536},{chunks:2},{operation:{...operation,ref:fileReference(I,binding,"files","other")}}])await expect(client(()=>({...good,...patch})).api.changeFile(r)).rejects.toMatchObject({code:"operation_unknown"});
});
test("directory pages cannot substitute foreign roots or pretend a non-child is an authorized entry",async()=>{
  const root=fileReference(I,binding,"files"),entry={ref,name:"note.txt",kind:"file" as const,size:1,mode:"0o600",modifiedAt:new Date(1).toISOString(),revision:null};
  const good={ref:root,entries:[entry],complete:true,nextCursor:null,snapshot:binding,contentIncluded:false as const};expect((await client(()=>good).api.fileDirectory(root)).data).toEqual(good);
  for(const entries of [[entry,entry],[{...entry,ref:fileReference(I,binding,"files","nested/note.txt")}],[{...entry,ref:fileReference(I,"c".repeat(64),"files","note.txt")}],[{...entry,content:"private"}]])await expect(client(()=>({...good,entries})).api.fileDirectory(root)).rejects.toMatchObject({code:"protocol_error"});
});
