import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { modelConfigurationRevision, persistedModelsRevision } from "@grokbox/runtime-kernel/model-management";
import { runModelChange, readModelOperation } from "@grokbox/runtime-kernel/commands";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { modelConfigurationLayer } from "../src/internal/io/model-management.node.ts";
import { managedModelAdmission } from "../src/internal/roots/model-management.runtime.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
const A="11111111-1111-4111-8111-111111111111", I="22222222-2222-4222-8222-222222222222";
const caller={installationId:I,principalId:"fixture-owner"};
const change={kind:"bot-selection" as const,agentId:A,selection:{kind:"default" as const}};
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"model-publication-check-")),store=openRuntimeStore(root,{});
  await store.saveModels(applyUse(parseModelsFile(undefined),"stub/echo"));
  const current=await store.loadModels(),next=applyUse(current,"stub/echo",A);
  return {root,store,current,next,bytes:()=>readFile(join(root,"models.json"),"utf8"),close:()=>rm(root,{recursive:true,force:true})};
}
test("the original physical models publisher refuses its final callback without replacing canonical bytes",async()=>{
  const f=await fixture();let checks=0;const refusal=Error("synthetic-publication-refusal");
  try {
    const before=await f.bytes();
    await expect(f.store.saveModels(f.next,persistedModelsRevision(f.current),async()=>{checks++;throw refusal;})).rejects.toBe(refusal);
    expect(checks).toBe(1);expect(await f.bytes()).toBe(before);
    expect((await readdir(f.root)).filter(name=>name.endsWith(".tmp"))).toEqual([]);
    await f.store.saveModels(f.next,persistedModelsRevision(f.current),async()=>{checks++;});
    expect(checks).toBe(2);expect(await f.bytes()).not.toBe(before);
  }finally{await f.close();}
});
test("permission lost between declaration and physical publication preserves the original unknown record without replay",async()=>{
  const f=await fixture();let allowed=true,saves=0,checks=0;const refusal=Error("synthetic-current-permission-lost");
  try {
    const before=await f.bytes(),signal=new AbortController().signal;
    const store={...f.store,saveModels:async(...args:Parameters<typeof f.store.saveModels>)=>{saves++;allowed=false;await f.store.saveModels(...args);}};
    const layer=modelConfigurationLayer(store);
    const admit=managedModelAdmission({ownershipRead:ownedOwnershipReader(4242),env:{},publication:{signal,authorize:async()=>{checks++;if(!allowed)throw refusal;}}});
    const request={requestId:randomUUID(),expectedRevision:modelConfigurationRevision(f.current),change};
    const run=()=>Effect.runPromise(runModelChange(caller,request,admit).pipe(Effect.provide(layer)));
    await expect(run()).rejects.toBe(refusal);expect(await f.bytes()).toBe(before);expect(saves).toBe(1);expect(checks).toBe(2);
    allowed=true;const retained=await Effect.runPromise(readModelOperation(caller,request.requestId).pipe(Effect.provide(layer)));
    if (!retained) throw Error("expected-original-model-receipt");
    expect(retained.state).toBe("unknown");expect(await run()).toEqual(retained);expect(saves).toBe(1);expect(checks).toBe(2);
  }finally{await f.close();}
});
test("publication checks cancellation after an awaited local authority read",async()=>{
  const f=await fixture(),controller=new AbortController();let checked=false;
  try {
    const admit=managedModelAdmission({ownershipRead:ownedOwnershipReader(4242),env:{},publication:{signal:controller.signal,
      authorize:async()=>{await Promise.resolve();checked=true;controller.abort();}}});
    const check=await Effect.runPromise(admit(change,f.next));
    await expect(check()).rejects.toBeDefined();expect(checked).toBe(true);
  }finally{await f.close();}
});
test("a real final authority wait cannot renew the original five-second native observation",async()=>{
  const f=await fixture();let reads=0;
  try {
    const original=ownedOwnershipReader(4242);
    const admit=managedModelAdmission({ownershipRead:async(...args)=>{reads++;return original(...args);},env:{},publication:{signal:new AbortController().signal,
      authorize:async()=>{await new Promise(resolve=>setTimeout(resolve,5100));}}});
    const check=await Effect.runPromise(admit(change,f.next));
    await expect(check()).rejects.toMatchObject({code:"runtime_ownership_unconfirmed"});expect(reads).toBe(1);
  }finally{await f.close();}
},10000);
test("withdrawing a model needs no native ownership but still cannot skip the final local authority check",async()=>{
  const f=await fixture();let checks=0;const refusal=Error("synthetic-reset-refused");
  try {
    const admit=managedModelAdmission({env:{},publication:{signal:new AbortController().signal,authorize:async()=>{checks++;throw refusal;}}});
    const check=await Effect.runPromise(admit({kind:"bot-selection",agentId:A,selection:{kind:"native"}},f.current));
    await expect(check()).rejects.toBe(refusal);expect(checks).toBe(1);
  }finally{await f.close();}
});
