import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite, type MonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { runMonitor } from "../src/internal/roots/monitor.runtime.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import { traceAlerts, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";

const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",SOURCE="b".repeat(64),HOST="c".repeat(64);
test("a competing SQLite reader delays the exact commit without killing the collector or repeating the Server query",async()=>{
 const root=await mkdtemp(join(tmpdir(),"monitor-busy-owned-")),store=openMonitorStore(root);
 await store.initialize();let reader:MonitorSqlite|undefined,reads=0,publications=0,release:Promise<void>|undefined;
 try{
  await runMonitor({durableRoot:root,agentIds:[AGENT],signal:new AbortController().signal,once:true,
   read:async()=>{
    reads++;
    reader=await openMonitorSqlite(store.path,"read");await reader.run("BEGIN");await reader.first("SELECT * FROM meta");
    release=new Promise<void>((resolve,reject)=>setTimeout(()=>{
      reader!.run("ROLLBACK").then(()=>reader!.close()).then(()=>{reader=undefined;resolve();},reject);
    },1350));
    return {snapshot:ownedOwnershipSnapshot([AGENT]),gateway:{pid:4242,startedAt:1700000000000}};
   },publish:receipt=>{publications++;expect(receipt.journal?.state).toBe("not_configured");}
  });
  await release;
  expect(reads).toBe(1);expect(publications).toBe(1);expect((await store.snapshot()).collectorRecordedRunning).toBe(false);
 }finally{await release;await reader?.close();await rm(root,{recursive:true,force:true});}
},10_000);

test("a no-tray failure exposes exactly which observer pieces were installed instead of claiming suppression",async()=>{
 const root=await mkdtemp(join(tmpdir(),"monitor-coverage-owned-"));const store=openMonitorStore(root),epoch=randomUUID();
 try{await store.initialize();await store.begin(epoch,Date.now(),[AGENT]);const events:unknown[]=[];
 createAlertObserver({generation:HOST,capture:{manager:false,mainDecision:false,automationDecision:false,inputCleanup:false},emit:event=>events.push(event)});
 events.push({name:"host_stream_rejected",schemaVersion:2,at:new Date().toISOString(),mode:"route",hostGenerationId:HOST,agentId:AGENT,turnId:"turn",stepId:"step",stage:"normalize",errorCode:"invalid_stream",reason:"invalid-stream"});
 for(const event of events)await appendHostJournal(root,event);
 const observed=await observeEvents(root,4096,{agentId:AGENT,stepId:"step"});const direct=traceAlerts(observed.events,{agentId:AGENT,stepId:"step"});
 expect(direct.traces).toEqual([]);expect(direct.instrumentation).toMatchObject([{managerAttached:"not_observed",capture:{manager:false,mainDecision:false}}]);
 await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:null,nextCursor:"one",events,atMs:Date.now()});
 const indexed=await store.alertTrace({agentId:AGENT,stepId:"step"});expect(indexed.instrumentation).toEqual(direct.instrumentation);expect(indexed.traces).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("pre-STEP refusal is indexed with its real operation identity, without a fabricated STEP",async()=>{
 const root=await mkdtemp(join(tmpdir(),"monitor-before-step-owned-")),store=openMonitorStore(root),epoch=randomUUID();
 try{await store.initialize();await store.begin(epoch,Date.now(),[AGENT]);
 const event={name:"host_stream_rejected",schemaVersion:2,at:new Date().toISOString(),mode:"route",hostGenerationId:HOST,agentId:AGENT,turnId:"turn",dispatchId:"dispatch",stage:"stream-id",errorCode:"invalid_envelope",reason:"missing-step-id"};
 const receipt=await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:null,nextCursor:"one",events:[event],atMs:Date.now()});expect(receipt.inserted).toBe(1);
 expect(await store.incidents()).toMatchObject([{rule:"pre_step_failure",diagnosis:{scope:"operation_not_step",stepId:null,dispatchId:"dispatch",state:"failure_observed"}}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
