import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",ROOT="b".repeat(64),HOST="c".repeat(64),BASE=Date.now();
async function fixture(){const root=await mkdtemp(join(tmpdir(),"monitor-source-lifecycle-")),store=openMonitorStore(root),epoch=randomUUID();await store.initialize();await store.begin(epoch,BASE,[AGENT]);let cursor:string|null=null,index=0;
 return {store,epoch,root,ingest:async(events:unknown[],at=BASE+index)=>{const next=String(++index);const receipt=await store.ingestEvidence({epoch,sourceKey:ROOT,expectedCursor:cursor,nextCursor:next,events,atMs:at});cursor=next;return receipt;},close:()=>rm(root,{recursive:true,force:true})};}
function alert(source:string,sequence:number,id=String(sequence)){return {name:"host_alert_observation",schemaVersion:1,kind:"tray_created",eventId:`event-${id}`,sourceInstanceId:source,sourceSequence:sequence,hostGenerationId:HOST,at:new Date(BASE).toISOString(),observedAt:new Date(BASE).toISOString(),trayId:"tray",agentId:AGENT};}

test("late source events close holes, while reused sequence identities remain integrity conflicts",async()=>{
 const f=await fixture();try{
  await f.ingest([alert("observer",0),alert("observer",3)]);expect((await f.store.storageHealth()).sources[0].gaps).toBe(2);
  await f.ingest([alert("observer",2)]);expect((await f.store.storageHealth()).sources[0].gaps).toBe(1);
  await f.ingest([alert("observer",1)]);expect((await f.store.storageHealth()).sources[0].gaps).toBe(0);
  expect((await f.ingest([alert("observer",2,"other-identity")])).conflicts).toBe(1);
  expect((await f.store.alertTrace({trayId:"tray"})).traces[0].integrity).toBe("conflict");
 }finally{await f.close();}
});
const execution={version:1,accepting:true,lifetimeStepLimit:null,activeSteps:0,hotStepRecords:0,hotTurns:0,pinnedTurns:0,pendingScopeReleases:0,
 history:{kind:"leveldb",available:true,reads:1,writes:1,failures:0,lastError:null},
 counters:{accepted:2,duplicate:0,completed:1,reclaimedSteps:2,coldRestores:0,coldStores:0,cleanupFailures:0}};
function terminal(serviceEpoch:string,stepId:string,at:number,ok=false){return {name:"model_step_terminal",schemaVersion:3,at:new Date(at).toISOString(),hostGenerationId:HOST,agentId:AGENT,turnId:"turn",stepId,serviceEpoch,
 outcome:ok?"ok":"error",phase:ok?"complete":"admission",eventCount:0,...(ok?{execution}:{failureCode:"ledger_unavailable"})};}
test("shared condition resolves only on later same-service positive evidence; a new cycle does not inherit acknowledgement",async()=>{
 const f=await fixture(),service=randomUUID();try{
  await f.ingest([terminal(service,"one",BASE)]);const old=(await f.store.incidents()).find(i=>i.rule==="shared_runtime_failure")!;
  await f.store.manage({requestId:randomUUID(),incidentId:old.id,expectedRevision:1,action:"ack",nowMs:BASE+1});
  await f.ingest([terminal(randomUUID(),"other-service",BASE+2,true)]);expect((await f.store.incidents()).find(i=>i.id===old.id)?.status).toBe("open");
  await f.ingest([terminal(service,"old-success",BASE-1,true)]);expect((await f.store.incidents()).find(i=>i.id===old.id)?.status).toBe("open");
  await f.ingest([terminal(service,"recovered",BASE+3,true)]);expect((await f.store.incidents()).find(i=>i.id===old.id)).toMatchObject({status:"resolved",acknowledged:true});
  const recurrence=await f.ingest([terminal(service,"new-cycle",BASE+4)]);const parents=(await f.store.incidents()).filter(i=>i.rule==="shared_runtime_failure");
  expect(parents).toHaveLength(2);expect(parents.find(i=>i.id!==old.id)).toMatchObject({status:"open",acknowledged:false});expect(recurrence.notifications?.filter(n=>n.decision==="emit")).toHaveLength(1);
  expect((await f.store.incidents()).filter(i=>i.rule==="execution_failure").every(i=>i.status==="recorded")).toBe(true);
 }finally{await f.close();}
});
test("a current complete batch decision is not rewritten when its source policy version changes later",async()=>{
 const f=await fixture();try{const event={...alert("observer",0),kind:"decision",trayId:undefined,decisionId:"decision",decision:"suppress",reason:"stale_run",ruleVersion:"native-host-v1",decisionBasis:"native_branch"};
  await f.ingest([event]);const old=(await f.store.events()).entries.length;
  const duplicate=await f.ingest([event]);expect(duplicate.inserted).toBe(0);expect((await f.store.events()).entries.length).toBe(old);
 }finally{await f.close();}
});
