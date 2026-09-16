import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { diagnoseExecution } from "@grokbox/runtime-kernel/alerts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";

const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST="b".repeat(64), SOURCE="c".repeat(64), NOW=Date.parse("2026-09-16T03:00:00Z");
const identity={agentId:AGENT,turnId:"turn",stepId:"step",hostGenerationId:HOST};
const host={...identity,name:"host_stream_rejected",schemaVersion:2,mode:"route",at:new Date(NOW).toISOString(),errorCode:"model_error",stage:"provider",reason:"terminal-rejected"};
const backend={...identity,name:"model_step_terminal",schemaVersion:3,at:new Date(NOW).toISOString(),serviceEpoch:randomUUID(),outcome:"error",phase:"admission",failureCode:"capacity",eventCount:0};

for(const backendFirst of [true,false])for(const separateBatches of [true,false]){
  test(`shared service parent is arrival-order independent: backendFirst=${backendFirst}, separateBatches=${separateBatches}`,async()=>{
    const root=await mkdtemp(join(tmpdir(),"monitor-correlation-")),store=openMonitorStore(root),epoch=randomUUID();
    try{
      await store.initialize();await store.begin(epoch,NOW,[AGENT]);const events=backendFirst?[backend,host]:[host,backend];
      if(separateBatches){
        await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:null,nextCursor:"one",events:[events[0]],atMs:NOW});
        await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:"one",nextCursor:"two",events:[events[1]],atMs:NOW+1});
      }else await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:null,nextCursor:"one",events,atMs:NOW});
      const incidents=await store.incidents(),child=incidents.find(e=>e.rule==="execution_failure"),parent=incidents.find(e=>e.rule==="shared_runtime_failure");
      expect(incidents).toHaveLength(2);expect(child?.parentIncidentId).toBe(parent?.id);expect(child?.status).toBe("recorded");
      expect(child?.diagnosis).toMatchObject({state:"failure_observed",backend:{phase:"admission",failureCode:"capacity"}});
    }finally{await rm(root,{recursive:true,force:true});}
  });
}

test("a late Host report cannot reopen the already resolved service condition of the same failed STEP",async()=>{
  const root=await mkdtemp(join(tmpdir(),"monitor-late-condition-")),store=openMonitorStore(root),epoch=randomUUID();
  try{
    await store.initialize();await store.begin(epoch,NOW,[AGENT]);
    await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:null,nextCursor:"one",events:[backend],atMs:NOW});
    const execution={version:1,accepting:true,lifetimeStepLimit:null,activeSteps:0,hotStepRecords:0,hotTurns:1,pinnedTurns:1,pendingScopeReleases:0,
      history:{kind:"leveldb",available:true,reads:3,writes:7,failures:0,lastError:null},counters:{accepted:2,duplicate:0,completed:1,reclaimedSteps:2,coldRestores:0,coldStores:0,cleanupFailures:0}};
    const recovered={...backend,stepId:"new-step",at:new Date(NOW+1000).toISOString(),outcome:"ok",phase:"complete",failureCode:undefined,execution};
    await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:"one",nextCursor:"two",events:[recovered],atMs:NOW+1000});
    expect((await store.incidents()).find(e=>e.rule==="shared_runtime_failure")?.status).toBe("resolved");
    await store.ingestEvidence({epoch,sourceKey:SOURCE,expectedCursor:"two",nextCursor:"three",events:[host],atMs:NOW+2000});
    const parents=(await store.incidents()).filter(e=>e.rule==="shared_runtime_failure");
    expect(parents).toHaveLength(1);expect(parents[0].status).toBe("resolved");
    expect((await store.incidents()).find(e=>e.rule==="execution_failure")?.status).toBe("recorded");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("the shared execution diagnosis agrees with CLI classification for a legacy opaque Host error",()=>{
  const events=[host,{...backend,phase:"normalize",failureCode:"stream_invalid",diagnostic:{normalizeCause:"missing_finish",rejectSite:"sdk_finish"}}];
  const core=diagnoseExecution(events,identity);
  const cli=projectSendOutcome({agentId:AGENT,stepId:identity.stepId,entries:[],alerts:[],truncated:false,runtimeEvents:events});
  expect(core).toMatchObject({code:cli.runtimeFailure!.code,stage:cli.runtimeFailure!.stage,diagnostic:cli.runtimeFailure!.diagnostic});
});

test("a known Host cause wins over a later generic backend symptom in every diagnosis view",()=>{
  const events=[{...host,errorCode:"invalid_stream",stage:"normalize",diagnostic:{normalizeCause:"undeclared_tool",rejectSite:"host_tool"}},{...backend,phase:"normalize",failureCode:"stream_invalid",diagnostic:{stream:{version:1,counts:{},timings:{},tail:[]}}}];
  expect(diagnoseExecution(events,identity)).toMatchObject({diagnostic:{normalizeCause:"undeclared_tool"}});
});

test("same STEP text in different service epochs is not a unique execution",()=>{
  expect(diagnoseExecution([backend,{...backend,serviceEpoch:randomUUID()}],identity)).toMatchObject({state:"unknown",reason:"ambiguous_execution"});
});
