import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { openRuntimeStore } from "@grokbox/box-runtime/runtime";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { applyModelChange, modelConfigurationRevision, parseModelChangeRequest } from "@grokbox/runtime-kernel/model-management";
import { startManagementServer, type AccessGrant, type ManagementNative } from "../src/server.ts";
import { ownedOwnershipReader } from "../../box-runtime/test/ownership-fixture.ts";
const I="11111111-1111-4111-8111-111111111111", A="22222222-2222-4222-8222-222222222222";
const TOKEN="synthetic-model-publication-owner";
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const denied=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(error:any)=>error?.code===code);
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"model-publication-http-")),physical=openRuntimeStore(root,{});
  await physical.saveModels(applyUse(parseModelsFile(undefined),"stub/echo"));
  const state={saves:0,nativeReads:0,checks:0,catalogCalls:0,catalog:undefined as undefined|(()=>Promise<void>),
    staged:undefined as undefined|(()=>Promise<void>),beforeSave:undefined as undefined|(()=>Promise<void>),
    beforeOwnership:undefined as undefined|(()=>Promise<void>),grantsHook:undefined as undefined|((signal:AbortSignal)=>Promise<void>),
    grants:[{tokenSha256:createHash("sha256").update(TOKEN).digest("hex"),principalId:"owner",capabilities:[...CAPABILITIES]}] as AccessGrant[]};
  const owned=ownedOwnershipReader(process.pid);
  const native:ManagementNative={listBots:async()=>{throw Error("not-used-for-model-publication");},ownershipRead:async(...args)=>{state.nativeReads++;await state.beforeOwnership?.();return owned(...args);}};
  const store={...physical,saveModels:async(...args:Parameters<typeof physical.saveModels>)=>{
    state.saves++;await state.beforeSave?.();
    return physical.saveModels(args[0],args[1],async()=>{
      await state.staged?.();assert.ok(args[2],"the real writer must receive the trusted final check");
      await args[2]();state.checks++;
    });
  }};
  const options={store,installationId:I,native,env:{SYNTHETIC_MODEL_KEY:"synthetic-model-key"},port:0,
    fetch:(async(_url:unknown,init?:RequestInit)=>{assert.equal(init?.method,"GET");state.catalogCalls++;await state.catalog?.();
      return new Response(JSON.stringify({data:[{id:"first"}]}),{status:200,headers:{"content-type":"application/json"}});}) as typeof fetch,readGrants:async(signal:AbortSignal)=>{await state.grantsHook?.(signal);return structuredClone(state.grants);}};
  let server=await startManagementServer(options,{hostHealth:{enabled:false}});
  return {root,state,physical,get server(){return server;},
    client:()=>new ManagementClient({baseUrl:server.url,installationId:I,credential:async()=>TOKEN}),
    bytes:()=>readFile(join(root,"models.json"),"utf8"),
    request:async()=>({requestId:randomUUID(),expectedRevision:modelConfigurationRevision(await physical.loadModels()),change:{kind:"bot-selection" as const,agentId:A,selection:{kind:"default" as const}}}),
    restart:async()=>{await server.close();server=await startManagementServer(options,{hostHealth:{enabled:false}});},
    close:async()=>{await server.close();await rm(root,{recursive:true,force:true});}};
}
for(const point of ["writer-entry","staged-file"] as const) for(const mode of ["revoked","rebound","token-removed"] as const)
  test(`HTTP final authorization preserves canonical bytes after ${point}/${mode}`,{timeout:15000},async()=>{
    const f=await fixture(),entered=gate(),resume=gate();let running:Promise<unknown>|undefined;
    try {
      const before=await f.bytes(),request=await f.request(),original=structuredClone(f.state.grants);
      const hold=async()=>{entered.release();await resume.promise;};
      if(point==="writer-entry")f.state.beforeSave=hold;else f.state.staged=hold;
      running=f.client().changeModels(request);void running.catch(()=>undefined);await Promise.race([entered.promise,running.then(()=>{throw Error("request ended before boundary");})]);
      if(point==="staged-file")assert.ok((await readdir(f.root)).some(name=>name.endsWith(".tmp")),"the real temporary file exists before the final check");
      if(mode==="revoked")f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(cap=>cap!=="models.write");
      else if(mode==="rebound")f.state.grants[0]!.principalId="other-owner";else f.state.grants=[];
      resume.release();await denied(running,mode==="token-removed"?"authentication_required":"permission_denied");
      assert.equal(await f.bytes(),before);assert.equal(f.state.saves,1);assert.equal(f.state.checks,0);
      assert.ok(!(await readdir(f.root)).some(name=>name.endsWith(".tmp")));
      f.state.grants=original;f.state.beforeSave=undefined;f.state.staged=undefined;
      const retained=(await f.client().modelOperation(request.requestId)).data;assert.equal(retained.state,"unknown");
      const reads=f.state.nativeReads;await denied(f.client().changeModels(request),"operation_unknown");
      assert.equal(f.state.saves,1);assert.equal(f.state.nativeReads,reads);assert.equal(await f.bytes(),before);
    } finally {resume.release();await running?.catch(()=>undefined);await f.close();}
  });
for(const revoke of [false,true])test(`Server shutdown joins staged model settlement with current grants: revoked=${revoke}`,{timeout:15000},async()=>{
  const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined,closing:Promise<void>|undefined;
  try {
    const before=await f.bytes(),request=await f.request(),grants=structuredClone(f.state.grants);
    f.state.staged=async()=>{entered.release();await resume.promise;};
    pending=f.client().changeModels(request).catch(()=>undefined);await entered.promise;
    let closed=false;closing=f.server.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);
    if(revoke)f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(cap=>cap!=="models.write");
    resume.release();await closing;await pending;assert.equal(closed,true);
    assert.equal((await f.bytes())!==before,!revoke);assert.equal(f.state.saves,1);
    f.state.grants=grants;f.state.staged=undefined;await f.restart();
    assert.equal((await f.client().modelOperation(request.requestId)).data.state,revoke?"unknown":"succeeded");
  } finally {resume.release();await pending?.catch(()=>undefined);await closing;await f.close();}
});
test("Server cancellation before declaration aborts the authority read and never starts publication",{timeout:15000},async()=>{
  const f=await fixture(),entered=gate();let aborted=false,pending:Promise<unknown>|undefined;
  try {
    const before=await f.bytes();
    f.state.beforeOwnership=async()=>{f.state.grantsHook=async signal=>{
      entered.release();await new Promise<void>((_resolve,reject)=>{const abort=()=>{aborted=true;reject(signal.reason);};
        if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});});
    };};
    pending=f.client().changeModels(await f.request()).catch(()=>undefined);await entered.promise;
    await f.server.close();await pending;assert.equal(aborted,true);assert.equal(f.state.saves,0);assert.equal(await f.bytes(),before);
    const files=await readdir(join(f.root,"state","model-operations"));assert.equal(files.filter(file=>file.endsWith(".json")).length,0);
  } finally {await f.close();}
});

const record={provider:"openai" as const,model:"first",endpoint:"https://models.example.test/v1",apiKeyRef:"env:SYNTHETIC_MODEL_KEY"};
for(const kind of ["reset","default-set","default-reset","model-put","model-patch","model-delete"] as const)
  test(`all model commands share final publication authority: ${kind}`,{timeout:15000},async()=>{
    const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined;
    try {
      let seed=applyModelChange(await f.physical.loadModels(),parseModelChangeRequest({requestId:randomUUID(),expectedRevision:"a".repeat(64),change:{kind:"model-put",modelId:"channel/first",model:record}}).change);
      if(kind==="reset")seed=applyUse(seed,"stub/echo",A);
      await f.physical.saveModels(seed);
      const request=await f.request(),before=await f.bytes();
      const changes={
        reset:{kind:"bot-selection",agentId:A,selection:{kind:"native"}},
        "default-set":{kind:"default-selection",selection:{modelId:"stub/echo"}},
        "default-reset":{kind:"default-selection",selection:null},
        "model-put":{kind:"model-put",modelId:"channel/new",model:record},
        "model-patch":{kind:"model-patch",modelId:"channel/first",patch:{contextWindowTokens:8192}},
        "model-delete":{kind:"model-delete",modelId:"channel/first"},
      };
      f.state.staged=async()=>{entered.release();await resume.promise;};
      pending=f.client().changeModels(parseModelChangeRequest({...request,change:changes[kind]}));void pending.catch(()=>undefined);await Promise.race([entered.promise,pending.then(()=>{throw Error("request ended before boundary");})]);
      f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(cap=>cap!=="models.write");resume.release();
      await denied(pending,"permission_denied");assert.equal(await f.bytes(),before);assert.equal(f.state.nativeReads,0);assert.equal(f.state.catalogCalls,0);
    } finally {resume.release();await pending?.catch(()=>undefined);await f.close();}
  });
test("revocation during the catalog await is checked before declaration without a repeated probe",{timeout:15000},async()=>{
  const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined;
  try {
    const seed=applyModelChange(await f.physical.loadModels(),parseModelChangeRequest({requestId:randomUUID(),expectedRevision:"a".repeat(64),change:{kind:"model-put",modelId:"channel/first",model:record}}).change);
    await f.physical.saveModels(applyUse(seed,"channel/first"));
    const before=await f.bytes();f.state.catalog=async()=>{entered.release();await resume.promise;};
    pending=f.client().changeModels(await f.request());void pending.catch(()=>undefined);await Promise.race([entered.promise,pending.then(()=>{throw Error("request ended before boundary");})]);
    f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(cap=>cap!=="models.write");resume.release();
    await denied(pending,"permission_denied");assert.equal(await f.bytes(),before);assert.equal(f.state.saves,0);assert.equal(f.state.catalogCalls,1);
    assert.equal((await readdir(join(f.root,"state","model-operations"))).length,0);
  } finally {resume.release();await pending?.catch(()=>undefined);await f.close();}
});
