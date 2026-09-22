import "./desktop-source.node.ts";
import "./desktop-crash-recovery.node.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ManagementClient } from "@grokbox/client";
import { openConfigStore, rootConfigLayout, publishConfigFile, desktopOperationKey } from "@grokbox/box-runtime/runtime";
import { desktopFixture, DESKTOP_AGENT as A, DESKTOP_MAIN as M, DESKTOP_INSTALLATION as I, DESKTOP_READER, DESKTOP_OWNER, DESKTOP_OTHER } from "../../../apps/web/test/desktop-fixture.ts";
const denied=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function intent(f:Awaited<ReturnType<typeof desktopFixture>>){const view=(await f.client().desktop()).data;assert.equal(view.state,"ready");return {requestId:randomUUID(),expectedRevision:view.revision!,confirmed:true as const};}

test("management uses the original classifier, exact display identity and one durable action; main desktop survives",async()=>{
  const f=await desktopFixture();try{
    const r=await intent(f),view=(await f.client().desktop()).data;assert.equal(view.canPrune,true);assert.equal(view.displays.find(r=>r.agentId===M)!.idle,false);
    const done=(await f.client().pruneDesktop(r)).data;assert.equal(done.state,"succeeded");assert.equal(done.rows.length,1);assert.equal(done.rows[0]!.observation,"display-dark");assert.equal(done.botDeleted,false);assert.equal(done.atomicSeatLease,false);assert.deepEqual(f.state.stops,[2]);
    assert.deepEqual((await f.client().pruneDesktop(r)).data,done);assert.deepEqual((await f.client().desktopOperation(r.requestId)).data,done);
    await denied(f.client().pruneDesktop({...r,expectedRevision:"c".repeat(64)}),"idempotency_conflict");
    await f.restart();await writeFile(join(f.root,"config.json"),"{corrupt");assert.deepEqual((await f.client().desktopOperation(r.requestId)).data,done);assert.deepEqual((await f.client().pruneDesktop(r)).data,done);assert.deepEqual(f.state.stops,[2]);assert.equal(f.state.nativeReads,0);
  }finally{await f.close();}
});
test("idle evidence missing or ambiguous cannot become reclaim eligibility",async()=>{
  const f=await desktopFixture();try{
    f.state.world.complete=false;let view=(await f.client().desktop()).data;assert.equal(view.state,"unavailable");assert.equal(view.canPrune,false);assert.ok(view.displays.every(r=>!r.idle));
    f.state.world.complete=true;f.state.world.assignments[M]=2;view=(await f.client().desktop()).data;assert.ok(view.displays.every(r=>r.busyReason==="ambiguous-seat"));
    f.state.world.assignments[M]=1;delete f.state.world.displayIdentities[2];view=(await f.client().desktop()).data;assert.equal(view.displays.find(r=>r.agentId===A)!.busyReason,"source-incomplete");
    const done=(await f.client().pruneDesktop(await intent(f))).data;assert.equal(done.rows.length,0);assert.deepEqual(f.state.stops,[]);
  }finally{await f.close();}
});
test("desktop reads, policy, helper execution and history have independent principal permissions",async()=>{
  const f=await desktopFixture();try{
    const r=await intent(f);await f.client(DESKTOP_READER).desktop();await denied(f.client(DESKTOP_READER).pruneDesktop(r),"permission_denied");
    await denied(f.client(DESKTOP_READER).changeDesktopPolicy({action:"keep",agentIds:[A],requestId:randomUUID(),expectedRevision:(await f.client().desktop()).data.configRevision!,confirmed:true}),"permission_denied");
    await f.client().pruneDesktop(r);await denied(f.client(DESKTOP_OTHER).desktopOperation(r.requestId),"not_found");assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
test("policy updates use the original config writer, preserve independent fields and recover historical receipts",async()=>{
  const f=await desktopFixture();try{
    const before=(await f.client().desktop()).data,r={action:"keep" as const,agentIds:[A],requestId:randomUUID(),expectedRevision:before.configRevision!,confirmed:true as const};
    const done=(await f.client().changeDesktopPolicy(r)).data;assert.equal(done.state,"succeeded");assert.equal(done.application,"not-observed");
    assert.deepEqual((await openConfigStore(rootConfigLayout(f.root)).read()).document.desktop!.keepAgentIds,[A]);
    const protectedView=(await f.client().desktop()).data;assert.equal(protectedView.displays.find(v=>v.agentId===A)!.protected,true);assert.equal(protectedView.canPrune,true);
    await denied(f.client().changeDesktopPolicy({...r,agentIds:[]}),"revision_conflict");
    await f.client().changeDesktopPolicy({action:"idle-reclaim",enabled:false,minIdleMs:900000,requestId:randomUUID(),expectedRevision:done.revision,confirmed:true});
    assert.deepEqual((await f.client().changeDesktopPolicy(r)).data,done);assert.deepEqual((await f.client().desktopPolicyOperation(r.requestId)).data,done);
    assert.equal((await openConfigStore(rootConfigLayout(f.root)).read()).document.desktop!.idleReclaim!.minIdleMs,900000);assert.deepEqual(f.state.stops,[]);
  }finally{await f.close();}
});
test("native floor changes after startup cannot masquerade as a current policy",async()=>{
  const f=await desktopFixture();try{
    const r=await intent(f),path=join(f.root,"state/installation.json"),installation=JSON.parse(await readFile(path,"utf8"));installation.desktop.floorAgentIds=[A];await publishConfigFile(path,installation);
    assert.equal((await f.client().desktop()).data.state,"unavailable");await denied(f.client().pruneDesktop(r),"revision_conflict");assert.deepEqual(f.state.stops,[]);
    await f.restart();const view=(await f.client().desktop()).data;assert.ok(view.displays.find(r=>r.agentId===A)!.protected);
  }finally{await f.close();}
});
test("changed observation revisions cannot substitute a new display into an approved batch",async()=>{
  const hooks:{afterClaim?:()=>Promise<void>}={},f=await desktopFixture(undefined,hooks);try{
    const r=await intent(f);hooks.afterClaim=async()=>{f.state.world.displayIdentities[2]="d".repeat(64);};
    await denied(f.client().pruneDesktop(r),"desktop_prune_refused");const operation=(await f.client().desktopOperation(r.requestId)).data;assert.equal(operation.state,"refused");assert.equal(operation.rows[0]!.state,"refused");assert.deepEqual(f.state.stops,[]);
  }finally{await f.close();}
});
test("permission revoked after the durable dispatch declaration prevents the helper invocation",async()=>{
  const hooks:{afterDispatchClaim?:()=>Promise<void>}={},f=await desktopFixture(undefined,hooks);try{
    const r=await intent(f);hooks.afterDispatchClaim=async()=>{f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="desktop.prune");};
    await denied(f.client().pruneDesktop(r),"desktop_prune_refused");assert.equal((await f.client().desktopOperation(r.requestId)).data.rows[0]!.state,"refused");assert.deepEqual(f.state.stops,[]);
  }finally{await f.close();}
});
test("installation floor changed after the dispatch declaration prevents a now-protected helper invocation",async()=>{
  const hooks:{afterDispatchClaim?:()=>Promise<void>}={},f=await desktopFixture(undefined,hooks);try{
    const r=await intent(f),path=join(f.root,"state/installation.json");
    hooks.afterDispatchClaim=async()=>{const installation=JSON.parse(await readFile(path,"utf8"));installation.desktop.floorAgentIds=[A];await publishConfigFile(path,installation);};
    await denied(f.client().pruneDesktop(r),"desktop_prune_refused");
    assert.deepEqual(f.state.stops,[]);assert.equal((await f.client().desktopOperation(r.requestId)).data.rows[0]!.state,"refused");
  }finally{await f.close();}
});
test("an unrelated policy publication after the dispatch claim cannot silently replace the approved review",async()=>{
  const hooks:{afterDispatchClaim?:()=>Promise<void>}={},f=await desktopFixture(undefined,hooks);try{
    const r=await intent(f);hooks.afterDispatchClaim=async()=>{f.config.desktop!.idleReclaim!.minIdleMs=900000;await f.save();};
    await denied(f.client().pruneDesktop(r),"desktop_prune_refused");assert.deepEqual(f.state.stops,[]);
  }finally{await f.close();}
});
test("lost helper settlement stays unknown and protects its display across a new UUID and restart",async()=>{
  const f=await desktopFixture();try{
    const r=await intent(f);f.state.stop=async(display)=>{(f.state.world.litDisplays as Set<number>).delete(display);throw Error("lost-native-helper-result");};
    await denied(f.client().pruneDesktop(r),"operation_unknown");const old=(await f.client().desktopOperation(r.requestId)).data;assert.equal(old.state,"unknown");assert.equal(old.rows[0]!.state,"unknown");
    await f.restart();(f.state.world.litDisplays as Set<number>).add(2);f.state.world.displayIdentities[2]="e".repeat(64);
    await denied(f.client().pruneDesktop(await intent(f)),"operation_unknown");assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
test("lost HTTP reply never resubmits a desktop stop; original request is independently readable",async()=>{
  const f=await desktopFixture();try{
    let posts=0;const client=new ManagementClient({baseUrl:f.server.url,installationId:I,credential:async()=>DESKTOP_OWNER,fetch:Object.assign(async(u:string|URL|Request,init?:RequestInit)=>{const response=await fetch(u,init);if(init?.method==="POST"){posts++;await response.arrayBuffer();throw Error("lost");}return response;},{preconnect:()=>undefined}) as typeof fetch});
    const r=await intent(f);await denied(client.pruneDesktop(r),"operation_unknown");assert.equal((await f.client().desktopOperation(r.requestId)).data.state,"succeeded");assert.equal(posts,1);assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
test("automatic work is explicitly enabled, uses the same store and cannot replay an unknown manual display",async()=>{
  const f=await desktopFixture(undefined,{intervalMs:15});try{
    await sleep(60);assert.deepEqual(f.state.stops,[]);
    f.state.stop=async()=>{throw Error("unsettled");};await denied(f.client().pruneDesktop(await intent(f)),"operation_unknown");
    const revision=(await f.client().desktop()).data.configRevision!;
    await f.client().changeDesktopPolicy({action:"idle-reclaim",enabled:true,minIdleMs:600000,requestId:randomUUID(),expectedRevision:revision,confirmed:true});
    await sleep(100);assert.deepEqual(f.state.stops,[2]);assert.equal((await f.client().desktop()).data.automatic,true);
    assert.ok(["working","unavailable"].includes((await f.client().desktop()).data.worker));
  }finally{await f.close();}
});
test("automatic reclaim continues without a page or CLI, and disabled configuration does not erase its history",async()=>{
  const f=await desktopFixture(undefined,{intervalMs:15});try{
    await f.client().changeDesktopPolicy({action:"idle-reclaim",enabled:true,minIdleMs:600000,requestId:randomUUID(),expectedRevision:(await f.client().desktop()).data.configRevision!,confirmed:true});
    const end=Date.now()+2000;while(f.state.stops.length===0&&Date.now()<end)await sleep(15);assert.deepEqual(f.state.stops,[2]);
    const directories=(await readdir(join(f.root,"state/desktop"))).filter(n=>n!=="identity.json");assert.equal(directories.length,1);
    const raw=JSON.parse(await readFile(join(f.root,"state/desktop",directories[0]!,"receipt.json"),"utf8"));assert.equal(raw.receipt.origin,"automatic");
    await sleep(80);assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
test("management close waits for the original helper and publication before another owner can act",async()=>{
  const f=await desktopFixture();try{
    let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);f.state.stop=async(_d,signal)=>{entered();await new Promise<void>(resolve=>{if(signal?.aborted)resolve();else signal?.addEventListener("abort",()=>resolve(),{once:true});});throw Error("original-helper-cancelled");};
    const r=await intent(f),run=f.client().pruneDesktop(r).catch(e=>e);await waiting;await f.server.close();await run;
    const path=join(f.root,"state/desktop",desktopOperationKey(I,"owner",r.requestId),"receipt.json"),before=await readFile(path);await sleep(30);assert.deepEqual(await readFile(path),before);assert.equal(JSON.parse(before.toString()).receipt.state,"unknown");
    await f.restart();assert.equal((await f.client().desktopOperation(r.requestId)).data.state,"unknown");assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
test("packaged CLI reads, changes policy and recovers the original desktop operation",async()=>{
  const f=await desktopFixture();try{
    const entry=process.env.GROKBOX_TEST_CLI_ENTRY;assert.ok(entry);
    const run=async(args:string[])=>{const child=spawn("node",[entry,...args],{cwd:f.root,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_DESKTOP_CREDENTIAL:DESKTOP_OWNER}});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);const timer=setTimeout(()=>child.kill("SIGKILL"),15000);const [code,signal]=await once(child,"close");clearTimeout(timer);assert.equal(signal,null);assert.equal(code,0,err);assert.ok(!out.includes(DESKTOP_OWNER));return JSON.parse(out).data;};
    const view=await run(["system","desktop","get"]),id=randomUUID();const result=await run(["system","desktop","prune","--request-id",id,"--expect-revision",view.revision,"--confirm"]);assert.equal(result.state,"succeeded");
    assert.deepEqual(await run(["operation","get","--domain","desktop","--request-id",id]),result);assert.deepEqual(f.state.stops,[2]);
  }finally{await f.close();}
});
