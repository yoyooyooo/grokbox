import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink, lstat, readdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ManagementClient } from "@grokbox/client";
import { publishConfigFile } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { readHostHealthJournal, readHostSourceEvidence } from "../../box-runtime/src/internal/io/provenance.node.ts";
import { projectHostHealth } from "@grokbox/runtime-kernel/host-health";
import { readHostSourceEvidencePins } from "../../box-runtime/src/internal/io/host-source-change.node.ts";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { hostHealthFixture, H_INSTALL, H_OWNER, H_READER } from "../../../apps/web/test/host-health-fixture.ts";
const origin="https://health.example.test", delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>Promise<T>,ok:(value:T)=>boolean,ms=8000){const end=Date.now()+ms;let last:unknown;do{try{const v=await read();if(ok(v))return v;last=v;}catch(e){last=String(e);}await delay(25);}while(Date.now()<end);throw Error(`health_test_deadline:${JSON.stringify(last)}`);}
const health=(f:Awaited<ReturnType<typeof hostHealthFixture>>)=>f.client().hostHealth();
// Static/runtime fault latches and consumable source-change occurrences have
// distinct lifetimes. Preserve the original fault/recovery assertions below.
const incidents=async(f:Awaited<ReturnType<typeof hostHealthFixture>>)=>(await f.observations.incidents()).filter(r=>r.rule==="host_patch_health"&&r.category==="condition");
const changes=async(f:Awaited<ReturnType<typeof hostHealthFixture>>)=>(await f.observations.incidents()).filter(r=>r.rule==="host_patch_health"&&r.category==="occurrence");

test("temporary attachment capacity recovers the same immutable episode without editing its earlier missing evidence",async()=>{
 let firstMissing:string|null=null,root="",changedWorker:string|null=null;
 const f=await hostHealthFixture(origin,{ports:{afterRetain:async()=>{
  if(!root||!changedWorker)return;
  const event=(await readHostHealthJournal(root,H_INSTALL))?.receipts.at(-1)?.event;
  if(event?.workerSha===changedWorker&&event.sourceChange?.after?.evidenceRef===null)firstMissing??=event.sourceChange.episodeId;
 }}});root=f.root;
 try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const path=join(f.root,"config.json"),config=JSON.parse(await readFile(path,"utf8"));
  await publishConfigFile(path,{...config,ops:{...config.ops,observation:{enabled:false}}});
  await until(()=>health(f),v=>v.data.state==="disabled");
  const dir=join(f.root,"host-bundles/source-evidence"),count=(await readdir(dir)).length;
  for(let n=count;n<68;n++)await writeFile(join(dir,`${"f".repeat(48)}${n.toString(16).padStart(16,"0")}.json`),"{}",{mode:0o600,flag:"wx"});
  const worker="module.exports = { changedAfterCapacity: true };\n";
  changedWorker=(await import("@grokbox/runtime-kernel/hash")).sha256Text(worker);
  await writeFile(f.paths.worker,worker,{mode:0o600});
  await publishConfigFile(path,{...config,ops:{...config.ops,observation:{enabled:true}}});
  const settled=await until(()=>health(f),v=>v.data.latest?.workerSha===changedWorker&&v.data.latest.analysis==="passed"
    &&!!v.data.latest.sourceChange?.after?.evidenceRef&&v.data.intake==="committed");
  assert.ok(firstMissing);
  assert.equal(settled.data.latest!.sourceChange!.episodeId,firstMissing);
  assert.equal(settled.data.latest!.sourceChange!.classification,"related-same-shape");
  const journal=(await readHostHealthJournal(f.root,H_INSTALL))!;
  assert.ok(journal.receipts.some(r=>r.event.sourceChange?.episodeId===firstMissing&&r.event.sourceChange.after?.evidenceRef===null));
  assert.equal((await readHostSourceEvidence(f.root,settled.data.latest!.sourceChange!.after!.evidenceRef!))!.worker,worker);
 }finally{await f.close();}
});

test("unsafe orphan cleanup cannot strand committed observations or fill the journal, and later cleanup recovers",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const orphan=join(f.root,"host-bundles/source-evidence",`${"f".repeat(64)}.json`);
  await writeFile(orphan,"{}",{mode:0o600});await chmod(orphan,0o644);
  const previous=(await health(f)).data.latest!.workerSha;
  await writeFile(f.paths.worker,"module.exports = { orphanIsolation: true };\n",{mode:0o600});
  await until(()=>health(f),v=>v.data.latest?.workerSha!==previous&&v.data.latest?.analysis==="passed"
    &&v.data.intake==="committed"&&v.data.reason==="evidence-retirement-unavailable");
  const journal=(await readHostHealthJournal(f.root,H_INSTALL))!;
  assert.equal(journal.acknowledgedThrough,journal.nextSequence-1);
  await delay(1100);
  assert.equal((await readHostHealthJournal(f.root,H_INSTALL))!.nextSequence,journal.nextSequence);
  assert.ok(await lstat(orphan));
  await chmod(orphan,0o600);
  await until(()=>health(f),v=>v.data.reason==="observed"&&v.data.intake==="committed");
  await assert.rejects(lstat(orphan),{code:"ENOENT"});
 }finally{await f.close();}
});

test("incomplete active pins defer cleanup and are retried after expiry without another source update",async()=>{
 const f=await hostHealthFixture(origin);let db:Awaited<ReturnType<typeof openMonitorSqlite>>|undefined;
 try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  db=await openMonitorSqlite(f.observations.path,"write");const now=Date.now();
  await db.run("BEGIN IMMEDIATE");
  for(let n=0;n<200;n++)await db.run("INSERT INTO notification_work(id,incident_id,evidence_revision,state,created_at,expires_at,last_reason) VALUES(?,?,1,'ready',?,?,'owned-pin-window-test')",
    [randomUUID(),randomUUID(),now-n,now+60000]);
  await db.run("COMMIT");
  const orphan=join(f.root,"host-bundles/source-evidence",`${"e".repeat(64)}.json`);
  await writeFile(orphan,"{}",{mode:0o600});
  await writeFile(f.paths.worker,"module.exports = { pendingPins: true };\n",{mode:0o600});
  await until(()=>health(f),v=>v.data.reason==="evidence-retirement-unavailable"&&v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const sequence=(await readHostHealthJournal(f.root,H_INSTALL))!.nextSequence;assert.ok(await lstat(orphan));
  await db.run("UPDATE notification_work SET expires_at=? WHERE last_reason='owned-pin-window-test'",[Date.now()-1]);
  await until(()=>health(f),v=>v.data.reason==="observed"&&v.data.intake==="committed");
  await assert.rejects(lstat(orphan),{code:"ENOENT"});
  assert.equal((await readHostHealthJournal(f.root,H_INSTALL))!.nextSequence,sequence);
 }finally{await db?.close();await f.close();}
});

test("actual TS candidate passes four Rust checks through the management owner with no Bot roster or native RPC",async()=>{
 const f=await hostHealthFixture(origin);try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.equal(v.data.assessment,"degraded");assert.equal(v.data.qualified,false);assert.equal(v.data.latest!.loaded,"not-observed");
  assert.deepEqual(v.data.latest!.uncoveredSlices,["create-session"]);assert.equal(v.data.latest!.notificationCoverage,"local-only");assert.equal(f.state.nativeCalls,0);assert.equal((await incidents(f)).length,0);
  const journal=await readHostHealthJournal(f.root,H_INSTALL), report=journal!.receipts.at(-1)!.analysis!;
  assert.equal(report.parser,"oxc-0.75.0");assert.equal(report.checks.length,4);assert.ok(report.checks.every(r=>r.state==="passed"));
  const count=f.state.pids.length;for(let i=0;i<4;i++)await health(f);await delay(650);assert.equal(f.state.pids.length,count);
  for(const pid of f.state.pids)assert.throws(()=>process.kill(pid,0));
  for(const secret of [f.root,"contextCheckpoint",H_OWNER,"Symbol.for","native-gateway"])assert.ok(!JSON.stringify(v).includes(secret));
 }finally{await f.close();}
});

for(const retired of ["health-contract","checker-revision"] as const)test(`retired ${retired} evidence is preserved but cannot restart as current health`,async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");await f.server.close();
  const path=join(f.root,"host-bundles","health","receipts.json"),document=JSON.parse(await readFile(path,"utf8"));
  if(retired==="health-contract")for(const row of document.receipts){
   row.event.contractRevision="host-health-v1";row.event.requiredChecks=row.event.requiredChecks.filter((id:string)=>id!=="context.lease-finally");
  }else for(const row of document.receipts)if(row.analysis)row.analysis.checks[0].revision=1;
  const stored=JSON.stringify(document)+"\n";await writeFile(path,stored,{mode:0o600});
  await assert.rejects(readHostHealthJournal(f.root,H_INSTALL));await f.restart();
  await until(()=>health(f),v=>v.data.state==="blocked");
  assert.equal((await health(f)).data.latest,null);assert.equal((await f.client().identity()).data.installationId,H_INSTALL);
  await f.server.close();assert.equal(await readFile(path,"utf8"),stored);assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("a definite recipe mismatch becomes one installation incident even when the Rust binary is unavailable",async()=>{
 const f=await hostHealthFixture(origin,{badRecipe:true,ports:{binaryDirectory:"/definitely-absent-verifier"}});try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="unavailable"&&v.data.intake==="committed");
  assert.equal(v.data.assessment,"blocked");const rows=await incidents(f);assert.ok(rows.length>=1);assert.ok(rows.every(r=>r.agentId===null));
  const initial=rows.map(r=>r.id).sort();await delay(700);assert.deepEqual((await incidents(f)).map(r=>r.id).sort(),initial);assert.equal(f.state.nativeCalls,0);
  const journal=await readHostHealthJournal(f.root,H_INSTALL);assert.ok(journal!.receipts.some(r=>r.event.applicability==="mismatch"&&r.event.analysis==="pending"));
  const work=await f.observations.notificationWork();assert.ok(work.length>=1); // work is not native delivery or permission
 }finally{await f.close();}
});

test("a semantically broken retry with freshly pinned valid source/candidate hashes opens a semantic condition and exact positive evidence resolves it",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed");
  const broken=f.slices.map(s=>s.id==="managed-turn-retry-gate"?{...s,replacement:s.replacement.replace("return false;","return true;")}:s);
  await f.writeProfile(f.source,broken);
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.deepEqual(v.data.latest!.failedChecks,["retry.turn-guard"]);
  const episode=v.data.latest!.sourceChange!.episodeId, journal=(await readHostHealthJournal(f.root,H_INSTALL))!;
  const phases=journal.receipts.filter(r=>r.event.sourceChange?.episodeId===episode);
  assert.ok(phases.some(r=>r.event.sourceChange!.classification==="unknown"));
  assert.ok(phases.some(r=>r.event.sourceChange!.classification==="structural-change"));
  assert.equal((await changes(f)).length,3); // initial unknown + pending new recipe + actual static risk upgrade
  const rows=await incidents(f);assert.equal(rows.filter(r=>r.status==="open").length,1);const id=rows.find(r=>r.status==="open")!.id;
  await f.writeProfile();await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"resolved");
 }finally{await f.close();}
});

test("lost lease-finally semantics become an installation incident before any native execution and survive restart",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const broken=f.slices.map(s=>s.id==="compact-register"?{...s,replacement:s.replacement.replace("__grokbox_compact_active = false;","__grokbox_compact_active = true;")}:s);
  await f.writeProfile(f.source,broken);
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.deepEqual(v.data.latest!.failedChecks,["context.lease-finally"]);
  const id=(await incidents(f)).find(r=>r.status==="open")!.id;
  await f.restart();await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,1);assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"open");
  await f.writeProfile();await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"resolved");assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("source disappearance is a detector gap, never evidence that a known recipe failure was repaired",async()=>{
 const f=await hostHealthFixture(origin,{badRecipe:true});try{
  await until(()=>health(f),v=>v.data.latest?.applicability==="mismatch"&&v.data.intake==="committed");const before=await incidents(f);
  await unlink(f.paths.source);const missing=await until(()=>health(f),v=>v.data.latest?.sourceState==="unavailable"&&v.data.intake==="committed");
  assert.equal(missing.data.latest!.sourceSha,null);assert.equal(missing.data.latest!.sourceSet,null);assert.equal(missing.data.assessment,"unknown");
  for(const row of before.filter(r=>r.status==="open"))assert.equal((await incidents(f)).find(r=>r.id===row.id)!.status,"open");
  await writeFile(f.paths.source,f.source,{mode:0o600});await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,0);
 }finally{await f.close();}
});

test("a retained receipt interrupted before OBS intake is replayed on restart without a duplicate incident or work item",async()=>{
 let retained=false;const f=await hostHealthFixture(origin,{badRecipe:true,ports:{afterRetain:async()=>{retained=true;throw Error("synthetic-after-retain");}}});
 try{
  await until(async()=>retained,v=>v);await f.server.close();assert.equal((await incidents(f)).length,0);
  const prior=(await readHostHealthJournal(f.root,H_INSTALL))!.receipts[0]!.event;
  delete f.ports.afterRetain;await f.restart();await until(()=>health(f),v=>v.data.intake==="committed"&&v.data.latest?.analysis!=="pending");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,1);
  const id=(await incidents(f))[0]!.id,count=(await f.observations.notificationWork()).length;
  await f.restart();await until(()=>health(f),v=>v.data.intake==="committed"&&v.data.latest?.analysis!=="pending");
  assert.equal((await incidents(f))[0]!.id,id);assert.equal((await f.observations.notificationWork()).length,count);
  assert.equal((await readHostHealthJournal(f.root,H_INSTALL))!.receipts[0]!.event.eventId,prior.eventId);
 }finally{await f.close();}
});

test("source A to B to A retains separate observation episodes but reuses immutable static analysis, not loaded qualification",async()=>{
 const f=await hostHealthFixture(origin);try{
  const first=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  await writeFile(f.paths.worker,"module.exports = {changed:true};\n",{mode:0o600});
  const next=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.latest?.sourceSet!==first.data.latest!.sourceSet);
  await writeFile(f.paths.worker,"// Independent companion.\nmodule.exports = {};\n",{mode:0o600});
  const restored=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.latest?.sourceSet===first.data.latest!.sourceSet&&v.data.latest.sourceSequence>next.data.latest!.sourceSequence);
  assert.notEqual(restored.data.latest!.sourceChange!.episodeId,first.data.latest!.sourceChange!.episodeId);
  assert.notEqual(restored.data.latest!.sourceChange!.episodeId,next.data.latest!.sourceChange!.episodeId);
  assert.notEqual(restored.data.latest!.eventId,first.data.latest!.eventId);assert.equal(restored.data.analyses,2);assert.equal(restored.data.latest!.loaded,"not-observed");
 }finally{await f.close();}
});

test("continuous versions coalesce pending work, retain late fixed results and never let history repair the latest failure",async()=>{
 let releaseA!:()=>void,releaseC!:()=>void;
 const holdA=new Promise<void>(resolve=>{releaseA=resolve;}),holdC=new Promise<void>(resolve=>{releaseC=resolve;}),started:string[]=[];
 const f=await hostHealthFixture(origin,{ports:{beforeAnalyze:async key=>{started.push(key);if(started.length===1)await holdA;else if(started.length===2)await holdC;}}});
 try{
  await until(async()=>started.length,n=>n===1);
  const first=await until(()=>health(f),v=>v.data.latest?.analysis==="pending");
  const sourceA=first.data.latest!.sourceSet!;
  await writeFile(f.paths.worker,"module.exports = {version:'B'};\n",{mode:0o600});
  const second=await until(()=>health(f),v=>v.data.latest?.analysis==="pending"&&v.data.latest.sourceSet!==sourceA);
  const sourceB=second.data.latest!.sourceSet!;
  await writeFile(f.paths.source,f.source+"\n// owned newer source\n",{mode:0o600});
  await writeFile(f.paths.worker,"module.exports = {version:'C'};\n",{mode:0o600});
  const third=await until(()=>health(f),v=>v.data.latest?.applicability==="mismatch"&&v.data.latest.workerSha!==second.data.latest!.workerSha&&v.data.intake==="committed");
  const sourceC=third.data.latest!.sourceSet!,failure=(await incidents(f)).find(r=>r.status==="open")!;
  assert.ok(failure);assert.deepEqual(started,[sourceA]);
  releaseA();
  const retained=await until(()=>readHostHealthJournal(f.root,H_INSTALL),j=>!!j?.receipts.some(row=>row.event.sourceState==="snapshot"&&row.event.sourceSet===sourceA));
  await until(async()=>started.length,n=>n===2);
  assert.deepEqual(started,[sourceA,sourceC]);assert.ok(!started.includes(sourceB));
  const late=retained!.receipts.find(row=>row.event.sourceState==="snapshot"&&row.event.sourceSet===sourceA)!;
  assert.equal(late.event.sourceChange!.episodeId,first.data.latest!.sourceChange!.episodeId);
  assert.notEqual(late.event.sourceChange!.episodeId,third.data.latest!.sourceChange!.episodeId);
  assert.equal(late.event.analysis,"passed");assert.equal(late.event.loaded,"not-observed");assert.equal(late.event.sourceEvolution!.nativeAbi.state,"not-run");
  const current=await health(f);assert.equal(current.data.latest!.sourceSet,sourceC);assert.equal(current.data.latest!.sourceState,"stable");assert.equal(current.data.latest!.analysis,"pending");
  assert.equal((await incidents(f)).find(row=>row.id===failure.id)!.status,"open");
  releaseC();await until(()=>health(f),v=>v.data.latest?.sourceSet===sourceC&&v.data.latest.analysis!=="pending"&&v.data.intake==="committed");
  assert.equal((await health(f)).data.analyses,2);const workCount=(await f.observations.notificationWork()).length;
  await f.restart();await until(()=>health(f),v=>v.data.observedAtMs!==null&&v.data.latest?.sourceSet===sourceC&&v.data.latest.analysis!=="pending"&&v.data.intake==="committed");
  assert.equal((await health(f)).data.analyses,0);assert.equal(started.length,2);
  assert.equal((await f.observations.notificationWork()).length,workCount);assert.equal(f.state.nativeCalls,0);
 }finally{releaseA();releaseC();await f.close();}
});

test("unconfigured OBS leaves local-only evidence and does not silently initialize an observation database",async()=>{
 const f=await hostHealthFixture(origin,{noMonitor:true});try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="unavailable");
  assert.equal(v.data.latest!.notificationCoverage,"local-only");await assert.rejects(f.observations.snapshot());assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("explicit disabled observation is inert and GET does not initialize health or native stores",async()=>{
 const f=await hostHealthFixture(origin,{disabled:true,noMonitor:true,ports:{enabled:false}});try{
  await until(()=>health(f),v=>v.data.state==="disabled");const before=await readdir(f.root);await health(f);await delay(80);
  assert.deepEqual(await readdir(f.root),before);assert.equal(f.state.pids.length,0);assert.equal(f.state.nativeCalls,0);assert.ok(!before.includes("host-bundles"));
 }finally{await f.close();}
});

test("owned updates traverse the real producer, public API, provenance and original OBS without an old condition swallowing new work",async()=>{
 const f=await hostHealthFixture(origin);try{
  const initial=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal(initial.data.latest!.sourceChange!.classification,"unknown");
  const firstTasks=(await changes(f)).length;
  const unrelated=f.source+"\n// unrelated owned trailer\n";
  await writeFile(f.paths.source,unrelated,{mode:0o600});
  const outside=await until(()=>health(f),v=>v.data.latest?.sourceSha!==initial.data.latest!.sourceSha&&v.data.latest?.analysis!=="pending"&&v.data.intake==="committed");
  assert.equal(outside.data.latest!.sourceChange!.classification,"no-intersection");
  assert.equal((await changes(f)).length,firstTasks);assert.equal((await incidents(f)).length,0);
  await writeFile(f.paths.worker,"module.exports = {version:'B'};\n",{mode:0o600});
  const related=await until(()=>health(f),v=>v.data.latest?.workerSha!==outside.data.latest!.workerSha&&v.data.latest?.analysis!=="pending"&&v.data.intake==="committed");
  assert.equal(related.data.latest!.sourceChange!.classification,"related-same-shape");
  assert.equal((await changes(f)).length,firstTasks+1);assert.ok((await incidents(f)).some(r=>r.status==="open"));
  const fixed=related.data.latest!.sourceChange!;
  assert.ok(fixed.before?.evidenceRef);assert.ok(fixed.after?.evidenceRef);
  await writeFile(f.paths.worker,"module.exports = {version:'C'};\n",{mode:0o600});
  const newer=await until(()=>health(f),v=>v.data.latest?.workerSha!==related.data.latest!.workerSha&&v.data.latest?.analysis!=="pending"&&v.data.intake==="committed");
  assert.equal(newer.data.latest!.sourceChange!.classification,"related-same-shape");
  assert.notEqual(newer.data.latest!.sourceChange!.episodeId,fixed.episodeId);assert.equal((await changes(f)).length,firstTasks+2);
  assert.equal((await readHostSourceEvidence(f.root,fixed.after!.evidenceRef!))!.worker,"module.exports = {version:'B'};\n");
  assert.ok(unrelated.includes("function shouldRetryTurnAttempt(input)"));
  await writeFile(f.paths.source,unrelated.replace("function shouldRetryTurnAttempt(input)", "function changedRetryTurnAttempt(input)"),{mode:0o600});
  const structural=await until(()=>health(f),v=>v.data.latest?.sourceChange?.classification==="structural-change"&&v.data.intake==="committed");
  assert.equal(structural.data.latest!.sourceChange!.reason,"recipe-structure-changed");
  const all=await changes(f), evidence=await Promise.all(all.map(r=>f.observations.incidentEvidence(r.id)));
  assert.ok(evidence.some(e=>e.facts.some(fact=>"value" in fact&&projectHostHealth(fact.value)?.sourceChange?.episodeId===fixed.episodeId)));
  assert.ok((await f.observations.notificationWork()).length>=all.length);
  const pins=await readHostSourceEvidencePins(f.root);
  assert.ok(pins?.includes(fixed.before!.evidenceRef!));assert.ok(pins?.includes(fixed.after!.evidenceRef!));
  for(const e of evidence)assert.ok(!JSON.stringify(e).includes("module.exports"));
  const ids=all.map(r=>r.id).sort();await f.restart();
  await until(()=>health(f),v=>v.data.latest?.analysis!=="pending"&&v.data.intake==="committed");
  assert.deepEqual((await changes(f)).map(r=>r.id).sort(),ids);
  await unlink(f.paths.worker);
  const missing=await until(()=>health(f),v=>v.data.latest?.sourceState==="unavailable"&&v.data.intake==="committed");
  assert.equal(missing.data.latest!.sourceChange!.classification,"unknown");
  assert.equal(missing.data.latest!.sourceChange!.after,null);
  assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("execution disabled still observes; explicit observation withdrawal and bad policy stop sampling without losing evidence",async()=>{
 const f=await hostHealthFixture(origin,{disabled:true});try{
  const configPath=join(f.root,"config.json"),config=JSON.parse(await readFile(configPath,"utf8"));
  const setObservation=(enabled:unknown)=>publishConfigFile(configPath,{...config,ops:{...config.ops,observation:{enabled}}});
  const first=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const episode=first.data.latest!.sourceChange!.episodeId;
  await setObservation(false);await until(()=>health(f),v=>v.data.state==="disabled");
  const prior=await readHostHealthJournal(f.root,H_INSTALL),pids=f.state.pids.length;
  await delay(100);assert.deepEqual(await readHostHealthJournal(f.root,H_INSTALL),prior);assert.equal(f.state.pids.length,pids);
  await setObservation(true);await until(()=>health(f),v=>v.data.state==="running"&&v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await health(f)).data.latest!.sourceChange!.episodeId,episode);
  await setObservation("invalid");await until(()=>health(f),v=>v.data.state==="blocked"&&v.data.reason==="observation-config-unavailable");
  const blocked=await readHostHealthJournal(f.root,H_INSTALL);
  await writeFile(f.paths.worker,"module.exports = {duringPause:true};\n",{mode:0o600});await delay(100);
  assert.deepEqual(await readHostHealthJournal(f.root,H_INSTALL),blocked);
  await setObservation(true);const resumed=await until(()=>health(f),v=>v.data.latest?.workerSha!==first.data.latest!.workerSha&&v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal(resumed.data.latest!.sourceChange!.classification,"related-same-shape");assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("a competing Server keeps ordinary HTTP responsive but cannot run the installation producer",async()=>{
 const f=await hostHealthFixture(origin);let other:Awaited<ReturnType<typeof startManagementServer>>|undefined;try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed");
  other=await startManagementServer({...f.options,port:0},{hostHealth:f.ports});
  const client=new ManagementClient({baseUrl:other.url,installationId:H_INSTALL,credential:async()=>H_OWNER});
  await until(()=>client.hostHealth(),v=>v.data.reason==="competing-owner");assert.equal((await client.identity()).data.installationId,H_INSTALL);
  const before=f.state.pids.length;await delay(100);assert.equal(f.state.pids.length,before);
 }finally{await other?.close();await f.close();}
});

test("health HTTP and packed CLI are read-only, authorized and scoped; shutdown leaves no writes or child",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  await assert.rejects(f.client(H_READER).hostHealth(),(e:any)=>e.code==="permission_denied");
  const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,"system","host","health"],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_HEALTH_CREDENTIAL:H_OWNER},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);const [code]=await once(child,"close");assert.equal(code,0,err+out);assert.equal(JSON.parse(out).data.latest.analysis,"passed");
  const reads=f.state.nativeCalls;await f.server.close();for(const pid of f.state.pids)assert.throws(()=>process.kill(pid,0));
  const journal=await readHostHealthJournal(f.root,H_INSTALL);await delay(100);assert.deepEqual(await readHostHealthJournal(f.root,H_INSTALL),journal);assert.equal(f.state.nativeCalls,reads);
 }finally{await f.close();}
});
