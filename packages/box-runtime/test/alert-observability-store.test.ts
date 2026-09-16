import { expect,test } from "bun:test";
import { mkdtemp,mkdir,writeFile,appendFile,readFile,rm,rename,stat,symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { hostVisibleStreamError } from "../src/internal/host/session.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { traceAlerts,chooseNotification, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";
const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",STEP="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",TURN="cccccccc-cccc-4ccc-8ccc-cccccccccccc",HOST="a".repeat(64),BASE=1789527600000;
function failure(at=BASE){return {name:"host_stream_rejected",schemaVersion:2,at:new Date(at).toISOString(),mode:"route",hostGenerationId:HOST,agentId:AGENT,turnId:TURN,stepId:STEP,stage:"normalize",errorCode:"invalid_stream",reason:"invalid-stream",failureId:"failure-one",diagnostic:{normalizeCause:"open_tools_at_finish",rejectSite:"host_terminal"}};}
async function fixture(options:Parameters<typeof openMonitorStore>[1]={}){
 const root=await mkdtemp(join(tmpdir(),"alert-monitor-")),run=join(root,"run"),store=openMonitorStore(root,options),epoch=randomUUID();await mkdir(join(run,"log"),{recursive:true});await store.initialize();await store.begin(epoch,BASE,[AGENT]);
 return {root,run,store,epoch,key:sha256Text(run),close:()=>rm(root,{recursive:true,force:true})};
}
function lifecycle(){const events:AlertObservationEvent[]=[];const observer=createAlertObserver({generation:HOST,now:()=>BASE,emit:e=>events.push(e)}),manager={getTrays:()=>[],emit:(_event:unknown)=>undefined};
 observer.attachManager(manager);
 const err=hostVisibleStreamError({failureId:"failure-one",code:"invalid_stream",agentId:AGENT,invocationId:STEP,userVisible:true,message:"PRIVATE_SENTINEL"});
 observer.decision(err,{agentId:AGENT},true,()=>manager.emit({type:"pushed",tray:{id:"tray-one",kind:"error",agentId:AGENT,requestId:"native-one",detail:"PRIVATE_SENTINEL"}}));
 observer.withRemovalReason("explicit_dismiss",()=>manager.emit({type:"dismissed",id:"tray-one"}));return events;}

test("journal and monitor use the same trace/diagnosis, including execution failure after dismiss",async()=>{
 const f=await fixture();try{const events=[failure(),...lifecycle()];for(const e of events)expect(await appendHostJournal(f.run,e)).toBe("written");
 const batch=await readJournalBatch(f.run,null);const first=await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:batch.nextCursor!,events:batch.events,atMs:BASE});expect(first.inserted).toBe(events.length);
 const direct=traceAlerts((await observeEvents(f.run,4096,{trayId:"tray-one"})).events,{trayId:"tray-one"});const indexed=await f.store.alertTrace({trayId:"tray-one"});
 expect(indexed.traces).toEqual(direct.traces);expect(indexed.traces[0].trays[0]).toMatchObject({hostState:"removed_observed",appRendered:"not_observed",executions:[{state:"failure_observed",code:"invalid_stream"}]});
 expect(JSON.stringify(indexed)).not.toContain("PRIVATE_SENTINEL");const before=await readFile(f.store.path),mtime=(await stat(f.store.path)).mtimeMs;
 await f.store.alertTrace({trayId:"tray-one"});await f.store.snapshot();await f.store.events();expect(await readFile(f.store.path)).toEqual(before);expect((await stat(f.store.path)).mtimeMs).toBe(mtime);
 const replay=await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:batch.nextCursor!,events:batch.events,atMs:BASE});expect(replay.duplicate).toBe(true);expect((await f.store.incidents()).filter(x=>x.rule==="execution_failure")).toHaveLength(1);
 }finally{await f.close();}
});
test("cursor and indexed events commit atomically; postcommit uncertainty does not duplicate decisions",async()=>{
 let fail=false,unknown=false;const f=await fixture({beforePublish:()=>{if(fail)throw Error("private-disk-error");},afterRename:()=>{if(unknown)throw Error("lost-receipt");}});
 const request={epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:"cursor-one",events:[failure()],atMs:BASE};
 try{fail=true;await expect(f.store.ingestEvidence(request)).rejects.toThrow("monitor_commit_failed");expect(await f.store.evidenceCursor(f.key)).toBeNull();expect(await f.store.incidents()).toEqual([]);
 fail=false;unknown=true;await expect(f.store.ingestEvidence(request)).rejects.toThrow("monitor_commit_unknown");unknown=false;
 expect((await f.store.ingestEvidence(request)).duplicate).toBe(true);expect((await f.store.events()).entries.filter(e=>e.kind==="notification_decided")).toHaveLength(1);
 }finally{await f.close();}
});
test("partial UTF8 line, malformed line and rotation preserve cursor evidence without fake events",async()=>{
 const f=await fixture();try{const path=join(f.run,"log/events.ndjson"),valid=JSON.stringify(failure());await writeFile(path,valid.slice(0,40));const partial=await readJournalBatch(f.run,null);expect(partial.events).toEqual([]);expect(JSON.parse(partial.nextCursor!).offset).toBe(0);
 await appendFile(path,valid.slice(40)+"\nnot-json\n"+JSON.stringify(lifecycle()[0])+"\n");const complete=await readJournalBatch(f.run,partial.nextCursor);expect(complete.events).toHaveLength(2);expect(complete.gap).toContain("malformed_line");
 await rename(path,path+".old");await writeFile(path,valid+"\n");const rotated=await readJournalBatch(f.run,complete.nextCursor);expect(rotated.gap).toContain("rotated");expect(rotated.events).toHaveLength(1);
 await rm(path);await symlink(path+".old",path);expect((await readJournalBatch(f.run,rotated.nextCursor)).gap).toBe("unavailable");
 }finally{await f.close();}
});
test("conflicting stable event IDs are not overwritten or silently counted as good replays",async()=>{
 const f=await fixture();try{const original=lifecycle().find(e=>e.kind==="decision")!;await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:"one",events:[original],atMs:BASE});
 const result=await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:"one",nextCursor:"two",events:[{...original,decision:"suppress",reason:"stale_run"}],atMs:BASE+1});expect(result.conflicts).toBe(1);expect(result.inserted).toBe(0);expect((await f.store.events()).entries.some(e=>e.kind==="source_conflict")).toBe(true);
 const raw=traceAlerts([original,{...original,decision:"suppress",reason:"stale_run"}],{agentId:AGENT});expect(raw.traces[0].integrity).toBe("conflict");
 }finally{await f.close();}
});
test("service-wide evidence groups notifications without erasing per-request failure facts",async()=>{
 const f=await fixture();try{const backend={name:"model_step_terminal",schemaVersion:3,at:new Date(BASE).toISOString(),hostGenerationId:HOST,agentId:AGENT,turnId:TURN,stepId:STEP,serviceEpoch:randomUUID(),outcome:"error",phase:"admission",failureCode:"capacity",eventCount:0};
 const result=await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:"one",events:[failure(),backend],atMs:BASE});
 expect(result.notifications?.filter(n=>n.decision==="emit")).toHaveLength(1);expect(result.notifications?.filter(n=>n.reason==="aggregated")).toHaveLength(1);
 const rows=await f.store.incidents();expect(rows).toHaveLength(2);expect(rows.find(r=>r.rule==="execution_failure")?.status).toBe("recorded");expect(rows.find(r=>r.rule==="shared_runtime_failure")?.status).toBe("open");expect(rows.find(r=>r.rule==="execution_failure")?.parentIncidentId).toBe(rows.find(r=>r.rule==="shared_runtime_failure")?.id);
 await f.store.recordNotificationExport(f.epoch,result.notifications??[],true,BASE+1);const exported=(await f.store.events()).entries.find(e=>e.kind==="notification_exported");expect(exported?.notification).toMatchObject({exportEvidence:"callback_returned",remoteReceipt:"not_configured",appRendered:"not_observed"});
 }finally{await f.close();}
});
test("retention is maintenance rather than a lifetime gate; acknowledgement operations remain idempotent",async()=>{
 const f=await fixture({retentionMs:100,eventTarget:2});try{
 const events=lifecycle();await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:"one",events:[failure(),...events],atMs:BASE});
 const incident=(await f.store.incidents())[0]!,request={incidentId:incident.id,requestId:randomUUID(),expectedRevision:1,action:"ack" as const,nowMs:BASE+1};await f.store.manage(request);
 const before=(await f.store.events()).cursor;const maintained=await f.store.maintain(BASE+1000);expect(maintained.removedEvidence).toBeGreaterThan(0);expect((await f.store.manage(request)).duplicate).toBe(true);
 expect((await f.store.alertTrace({trayId:"tray-one"})).evidence.matching).toBe("not_observed_in_window");
 await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:"one",nextCursor:"two",events:[{...failure(BASE+1001),stepId:randomUUID()}],atMs:BASE+1001});
 expect((await f.store.snapshot()).storage.lifetimeEventLimit).toBeNull();expect((await f.store.events()).cursor).not.toBe(before);
 }finally{await f.close();}
});
test("more than the old byte and event ceilings remains queryable and accepts the next observation",async()=>{
 const f=await fixture();try{const db=await openMonitorSqlite(f.store.path,"write");try{
 await db.run("BEGIN IMMEDIATE; WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50010) INSERT INTO evidence(ref,digest,source_key,at_ms,payload) SELECT 'seed-'||x,'hash','seed',1,json_object('padding',hex(zeroblob(200))) FROM n; COMMIT;");
 }finally{await db.close();}
 expect((await stat(f.store.path)).size).toBeGreaterThan(16*1024*1024);
 const result=await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.key,expectedCursor:null,nextCursor:"one",events:lifecycle(),atMs:BASE});expect(result.inserted).toBeGreaterThan(0);
 expect((await f.store.alertTrace({trayId:"tray-one"})).traces[0].trays[0].hostState).toBe("removed_observed");expect((await f.store.maintain(BASE)).removedEvidence).toBeGreaterThan(0);
 }finally{await f.close();}
},30_000);
test("notification acknowledgement, snooze, grouping and execution results remain separate",()=>{
 expect(chooseNotification({acknowledged:true,snoozeUntilMs:null,nowMs:BASE})).toMatchObject({decision:"suppress",reason:"acknowledged"});
 expect(chooseNotification({acknowledged:false,snoozeUntilMs:BASE+1,nowMs:BASE})).toMatchObject({reason:"snoozed"});
 expect(chooseNotification({acknowledged:false,snoozeUntilMs:BASE-1,nowMs:BASE})).toMatchObject({decision:"emit"});
});
