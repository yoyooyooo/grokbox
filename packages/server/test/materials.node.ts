import "./materials-boundaries.node.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, symlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { materialsFixture, materialUntil, MATERIAL_BOT, MATERIAL_INSTALLATION, MATERIAL_READER, MATERIAL_SEARCHER, BODY_SENTINEL } from "../../../apps/web/test/materials-fixture.ts";
import { materialReference, type MaterialMetadata } from "@grokbox/client";
const origin="https://materials.example.test";
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&e.code===code);
async function ready(f:Awaited<ReturnType<typeof materialsFixture>>){return materialUntil(()=>f.client().materials(),r=>r.data.items.length===8);}
const file=(items:MaterialMetadata[])=>items.find(x=>x.path==="notes.md")!;
const request=(doc:MaterialMetadata,content="Updated source text.\n")=>({ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content,confirmed:true as const});

test("unconfigured material reads create no store or sources and never call native services",async()=>{
 const f=await materialsFixture(origin,{enabled:false});try{
  const before=await readdir(f.root);const state=(await f.client().materialStatus()).data;
  assert.equal(state.state,"not-configured");assert.deepEqual(state.sources,[]);assert.equal(await f.index.exists(),false);
  await rejects(f.client().materials(),"source_unavailable");assert.deepEqual(await readdir(f.root),before);assert.equal(f.nativeReads(),0);
 }finally{await f.close();}
});
test("Agent/User/Project shards, membership and ordinary files remain distinct bounded source objects",async()=>{
 const f=await materialsFixture(origin);try{
  const page=(await ready(f)).data;
  assert.equal(page.items.filter(d=>d.kind==="memory").length,4);assert.equal(new Set(page.items.map(d=>d.ref)).size,8);
  assert.equal(page.items.filter(d=>d.writable).length,2);
  const membership=page.items.find(d=>d.kind==="membership")!;assert.deepEqual(membership.membership,["alpha"]);
  for(const forbidden of [BODY_SENTINEL,"UNAUTHORIZED_SHARD","SYNTHETIC_SECRET_NOT_A_DOCUMENT","not-authorized",f.nativeRoot,f.filesRoot])assert.ok(!JSON.stringify(page).includes(forbidden));
  const memory=page.items.find(d=>d.kind==="memory"&&d.scope==="agent"&&d.path.endsWith("profile.md"))!;
  assert.ok((await f.client().readMaterial(memory.ref)).data.content.includes(BODY_SENTINEL));
  assert.deepEqual(JSON.parse((await f.client().readMaterial(membership.ref)).data.content),{projects:["alpha"]});
  assert.ok(page.sources.every(s=>s.upstreamSync==="not-observed"&&s.identityBasis==="explicit-source-binding"));assert.equal(f.nativeReads(),0);
 }finally{await f.close();}
});
test("search is literal, bounded and separately authorized; metadata permissions never grant body reads",async()=>{
 const f=await materialsFixture(origin,{intervalMs:1000});try{
  await ready(f);const found=(await f.client(MATERIAL_SEARCHER).materials({query:"SHARED PHRASE"})).data;assert.equal(found.items.length,4);
  assert.ok(!JSON.stringify(found).includes(BODY_SENTINEL));assert.equal((await f.client().materials({query:"[a-z].*"})).data.items.length,0);
  const doc=file((await f.client(MATERIAL_READER).materials()).data.items);
  await rejects(f.client(MATERIAL_READER).materials({query:"shared"}),"permission_denied");await rejects(f.client(MATERIAL_READER).readMaterial(doc.ref),"permission_denied");
  await rejects(f.client(MATERIAL_READER).changeMaterial(request(doc)),"permission_denied");
  const a=(await f.client().materials({limit:2})).data,b=(await f.client().materials({limit:2,cursor:a.nextCursor!})).data;
  assert.equal(new Set([...a.items,...b.items].map(x=>x.ref)).size,4);
  await rejects(f.client().materials({limit:2,cursor:a.nextCursor!,query:"different"}),"cursor_gap");
 }finally{await f.close();}
});
test("direct source reads expose index lag and do not claim the content was used by any TURN",async()=>{
 const f=await materialsFixture(origin,{intervalMs:1000});try{
  const doc=file((await ready(f)).data.items);await f.put(f.filesRoot,"notes.md","External edit not yet indexed.\n");
  const direct=(await f.client().readMaterial(doc.ref)).data;assert.equal(direct.content,"External edit not yet indexed.\n");
  assert.equal(direct.indexState,"lagging");assert.equal(direct.indexedRevision,doc.revision);assert.equal(direct.includedInTurn,"not-observed");
  await materialUntil(()=>f.client().materials({query:"External edit"}),r=>r.data.items.length===1);
  assert.equal((await f.client().readMaterial(doc.ref)).data.indexState,"matched");assert.equal(f.nativeReads(),0);
 }finally{await f.close();}
});
test("a file replacement records its exact historical receipt; restart/replay performs no second source write",async()=>{
 const f=await materialsFixture(origin);try{
  const doc=file((await ready(f)).data.items),input=request(doc),result=(await f.client().changeMaterial(input)).data;
  assert.equal(result.state,"succeeded");assert.equal(result.evidence,"source-readback");assert.equal(result.externalCompareAndSwap,false);
  assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),input.content);
  const before=await stat(join(f.filesRoot,"notes.md"));await f.restart();
  assert.deepEqual((await f.client().materialOperation(input.requestId)).data,result);
  assert.deepEqual((await f.client().changeMaterial(input)).data,result);assert.equal((await stat(join(f.filesRoot,"notes.md"))).mtimeMs,before.mtimeMs);
  await rejects(f.client().changeMaterial({...input,content:"different"}),"idempotency_conflict");
  await rejects(f.client(MATERIAL_READER).materialOperation(input.requestId),"not_found");
 }finally{await f.close();}
});
test("native Memory/Project documents cannot be changed through the generic file write lane",async()=>{
 const f=await materialsFixture(origin);try{
  const page=(await ready(f)).data;
  for(const doc of page.items.filter(x=>x.kind!=="file"))await rejects(f.client().changeMaterial(request(doc)),"permission_denied");
  const native=page.items.find(x=>x.sourceId==="native")!;
  const ref=materialReference(MATERIAL_INSTALLATION,native.binding,"native",`agents/${MATERIAL_BOT}/profile.json`);
  await rejects(f.client().readMaterial(ref),"permission_denied");
  const foreign=materialReference(MATERIAL_INSTALLATION,native.binding,"native",`agents/99999999-9999-4999-8999-999999999999/memory/profile.md`);
  await rejects(f.client().readMaterial(foreign),"permission_denied");assert.equal(f.nativeReads(),0);
 }finally{await f.close();}
});
test("unknown after publication survives service restart, matching bytes and index rebuild without re-execution",async()=>{
 let inject=true;const f=await materialsFixture(origin,{writeHooks:{afterPublish:async()=>{if(inject)throw Error("synthetic_lost_publication_reply");}}});try{
  const doc=file((await ready(f)).data.items),input=request(doc,"Published once despite lost reply.\n");
  await rejects(f.client().changeMaterial(input),"operation_unknown");inject=false;await f.restart();
  assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),input.content);
  assert.equal((await f.client().materialOperation(input.requestId)).data.state,"unknown");
  await rejects(f.client().changeMaterial(input),"operation_unknown");
  const newer=(await f.client().readMaterial(doc.ref)).data.document;
  await rejects(f.client().changeMaterial(request(newer,"Do not repeat.\n")),"operation_unknown");
  assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),input.content);
 }finally{await f.close();}
});
test("symlinks, hard source rebinding and path traversal cannot turn one document reference into another",async()=>{
 const f=await materialsFixture(origin);try{
  const doc=file((await ready(f)).data.items);await symlink(join(f.nativeRoot,`agents/${MATERIAL_BOT}/memory/profile.md`),join(f.filesRoot,"leak.md"));
  await rejects(f.client().readMaterial(materialReference(MATERIAL_INSTALLATION,doc.binding,"documents","leak.md")),"source_unavailable");
  assert.throws(()=>materialReference(MATERIAL_INSTALLATION,doc.binding,"documents","../native/private.md"));
  await rename(f.filesRoot,`${f.filesRoot}-original`);await mkdir(f.filesRoot,{mode:0o700});await f.put(f.filesRoot,"notes.md","Replacement root.");
  await rejects(f.client().readMaterial(doc.ref),"source_changed");await rejects(f.client().changeMaterial(request(doc)),"source_changed");
  assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"Replacement root.");
 }finally{await f.close();}
});
