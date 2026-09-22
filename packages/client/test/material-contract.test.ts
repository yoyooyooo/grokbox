import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, materialReference, materialIdentity, normalizeMaterialWrite, normalizeMaterialQuery, fileReference, fileIdentity, type MaterialMetadata, type MaterialOperation, type MaterialSourceView } from "../src/client.ts";
import { materialMetadata, materialPage, materialRead, materialOperation, materialSource } from "../src/material-validation.ts";
const installation="11111111-1111-4111-8111-111111111111",binding="a".repeat(64),before="b".repeat(64);
const ref=materialReference(installation,binding,"notes","notes.md");
const metadata:MaterialMetadata={ref,sourceId:"notes",binding,path:"notes.md",kind:"file",scope:"file",agentId:null,project:null,bytes:4,revision:before,modifiedAtMs:1,writable:true,membership:[],contentIncluded:false,author:"not-observed"};
const source:MaterialSourceView={id:"notes",kind:"files",accountScope:"c".repeat(64),binding,state:"ready",indexedAtMs:1,attemptedAtMs:1,documents:1,skipped:0,reason:null,writable:true,freshness:"fresh",coverage:"configured-local-sources",upstreamSync:"not-observed",identityBasis:"explicit-source-binding"};
const request=()=>({requestId:randomUUID(),ref,expectedRevision:before,content:"PRIVATE_DRAFT_SENTINEL",confirmed:true as const});
const receipt=(requestId:string):MaterialOperation=>({requestId,operationRef:`material-operation:${installation}:${"d".repeat(64)}`,ref,sourceId:"notes",binding,beforeRevision:before,afterRevision:"e".repeat(64),state:"succeeded",acceptedAtMs:1,settledAtMs:2,sourceWrite:"replace-existing-text",evidence:"source-readback",externalCompareAndSwap:false,indexAdoption:"not-observed"});
const envelope=(data:unknown)=>Response.json({schemaVersion:1,installationId:installation,invocationId:randomUUID(),ok:true,data});

test("material metadata never accepts private source paths, content, inferred writers or writable native replicas",()=>{
 expect(materialMetadata(metadata,installation)).toBe(true);expect(materialSource(source)).toBe(true);
 for(const patch of [{content:"secret"},{root:"/private/root"},{author:"Bot"},{contentIncluded:true},{scope:"agent"},{revision:"bad"}])expect(materialMetadata({...metadata,...patch},installation)).toBe(false);
 expect(materialMetadata({...metadata,kind:"memory",scope:"agent",agentId:randomUUID()},installation)).toBe(false);
 expect(materialSource({...source,kind:"native-memory",writable:true})).toBe(false);
 expect(materialSource({...source,upstreamSync:"fresh"})).toBe(false);
});
test("search pages bind source identities and query filters and cannot claim reconstructed history",()=>{
 const page={items:[metadata],nextCursor:null,snapshot:"f".repeat(64),sources:[source],search:"none",coverage:"indexed-window",contentIncluded:false};
 expect(materialPage(page,installation,{})).toBe(true);
 for(const patch of [{items:[metadata,metadata]},{sources:[{...source,binding:"f".repeat(64)}]},{contentIncluded:true},{historyComplete:true},{nextCursor:`${"a".repeat(64)}:5`}])expect(materialPage({...page,...patch},installation,{})).toBe(false);
 expect(materialPage(page,installation,{kind:"project"})).toBe(false);expect(materialPage(page,installation,{query:"text"})).toBe(false);
});
test("direct reads retain exact reference and index-lag semantics without asserting TURN adoption",()=>{
 const value={document:metadata,content:"text",encoding:"utf8",observedAtMs:2,source:"direct-read",contentProjection:"exact-text",indexedRevision:before,indexState:"matched",includedInTurn:"not-observed"};
 expect(materialRead(value,installation,ref)).toBe(true);
 for(const patch of [{indexState:"lagging"},{indexedRevision:null},{includedInTurn:true},{privateUrl:"anything"}])expect(materialRead({...value,...patch},installation,ref)).toBe(false);
 expect(materialRead(value,installation,materialReference(installation,binding,"notes","other.md"))).toBe(false);
});
test("material writes reject traversal, mixed input, unbound targets and accessors before any transport call",async()=>{
 let credentials=0,requests=0,accessed=0;
 const client=new ManagementClient({baseUrl:"http://localhost",installationId:installation,credential:async()=>{credentials++;return "test";},fetch:Object.assign(async()=>{requests++;return envelope({});},{preconnect:fetch.preconnect})});
 for(const patch of [{confirmed:false},{rawPath:"/anything"},{content:"x".repeat(32769)},{expectedRevision:"none"},{ref:ref.replace("notes.md","..%2Fsecret.md")}])expect(()=>client.changeMaterial({...request(),...patch} as never)).toThrow();
 const accessor={...request()};Object.defineProperty(accessor,"content",{get(){accessed++;return "private";}});expect(()=>normalizeMaterialWrite(accessor,installation)).toThrow();
 expect(()=>materialIdentity(ref,"")).toThrow();expect(()=>normalizeMaterialQuery({limit:0})).toThrow();expect(()=>normalizeMaterialQuery({url:"https://example.test"} as never)).toThrow();
 expect(()=>materialReference(installation,binding,"notes","/absolute.md")).toThrow();expect(()=>materialReference(installation,binding,"notes","folder\\file.md")).toThrow();
 expect(credentials).toBe(0);expect(requests).toBe(0);expect(accessed).toBe(0);
});
test("material refs stay distinct from named-root refs and client validation rejects unqualified Project fileRefs",()=>{
 const namedRoot=fileReference(installation,binding,"workspace","project/notes.md");
 expect(namedRoot.startsWith("file:")).toBe(true);expect(namedRoot.startsWith("material:")).toBe(false);
 expect(()=>materialIdentity(namedRoot,installation)).toThrow();expect(()=>fileIdentity(ref,installation)).toThrow();
 const project={...metadata,sourceId:"project-alpha",path:"projects/alpha/project.md",ref:materialReference(installation,binding,"project-alpha","projects/alpha/project.md"),kind:"project" as const,scope:"project" as const,agentId:null,project:"alpha",writable:false};
 expect(materialMetadata(project,installation)).toBe(true);
 expect(materialMetadata({...project,fileRef:namedRoot},installation)).toBe(false);
});

test("lost or mismatched material success preserves the original recovery locator, not the caller's later edits",async()=>{
 const input=request(),original={...input};let sent:unknown;
 const client=new ManagementClient({baseUrl:"http://localhost",installationId:installation,credential:async()=>{input.requestId=randomUUID();input.ref=materialReference(installation,binding,"notes","other.md");return "test";},fetch:Object.assign(async(_url:string|URL|Request,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));return envelope({...receipt(original.requestId),ref:input.ref});},{preconnect:fetch.preconnect})});
 await expect(client.changeMaterial(input)).rejects.toMatchObject({code:"operation_unknown",details:{requestId:original.requestId,lookupPath:`/v1/material-operations/${original.requestId}`}});
 expect(sent).toEqual(original);
 const valid=receipt(original.requestId);expect(materialOperation(valid,installation,original.requestId,original)).toBe(true);
 for(const patch of [{externalCompareAndSwap:true},{indexAdoption:"applied"},{beforeRevision:"f".repeat(64)},{evidence:"inferred-from-current-bytes"}])expect(materialOperation({...valid,...patch},installation,original.requestId,original)).toBe(false);
});
