import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { captureCli } from "./helpers.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { runAlertTrace } from "../packages/cli/src/commands/alert-trace.ts";
import { createAlertObserver } from "../packages/box-runtime/src/internal/host/alert-observation.ts";
import { hostVisibleStreamError } from "../packages/box-runtime/src/internal/host/session.ts";
import { openMonitorStore } from "../packages/box-runtime/src/internal/io/monitor-store.node.ts";
import type { AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";

const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST="b".repeat(64);
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"alert-trace-command-")),run=join(root,"run"),durable=join(root,"durable");await mkdir(join(run,"log"),{recursive:true});await mkdir(durable,{mode:0o700});
  const events:unknown[]=[],observer=createAlertObserver({generation:HOST,emit:(e:AlertObservationEvent)=>events.push(e)});
  const manager={getTrays:()=>[],emit:(_e:unknown)=>undefined};observer.attachManager(manager);
  const failure={name:"host_stream_rejected",schemaVersion:2,at:new Date().toISOString(),mode:"route",agentId:AGENT,hostGenerationId:HOST,turnId:"turn",stepId:"step",failureId:"failure",reason:"invalid-stream",errorCode:"invalid_stream",stage:"normalize"};
  events.push(failure);
  observer.decision(hostVisibleStreamError({failureId:"failure",agentId:AGENT,invocationId:"step",userVisible:true,code:"invalid_stream",message:"PRIVATE_SENTINEL"}),{agentId:AGENT},true,()=>manager.emit({type:"pushed",tray:{id:"tray",kind:"error",agentId:AGENT}}));
  observer.withRemovalReason("new_input_cleanup",()=>manager.emit({type:"dismissed",id:"tray"}));
  await writeFile(join(run,"log/events.ndjson"),events.map(e=>JSON.stringify(e)+"\n").join(""));
  const deps={boxRuntimeRoot:durable,configDir:join(root,"config"),discoveryPath:join(root,"absent-gateway.json"),daemonSocket:join(root,"absent.sock"),transport:"local" as const,env:{GROKBOX_RUN_ROOT:run}};
  return {root,run,durable,events,deps,close:()=>rm(root,{recursive:true,force:true})};
}

test("alert trace is useful with no Gateway; its monitor variant never initializes a missing store",async()=>{
  const f=await fixture();try{
    const result=await captureCli(["alerts","trace","tray","--agent",AGENT],f.deps);expect(result.code,result.stderr).toBe(0);
    const report=JSON.parse(result.stdout).data;expect(report.traces[0].trays[0]).toMatchObject({hostState:"removed_observed",removalReason:"new_input_cleanup",appRendered:"not_observed",userRead:"not_proven"});
    expect(report.traces[0].trays[0].executions[0]).toMatchObject({state:"failure_observed",code:"invalid_stream"});expect(result.stdout).not.toContain("PRIVATE_SENTINEL");
    const missing=await captureCli(["alerts","trace","tray","--from","monitor"],f.deps);expect(missing.code).not.toBe(0);expect(await readdir(f.durable)).toEqual([]);
    // runCli resolves a Profile and replaces raw transport overrides. Exercise
    // the command's resolved capability boundary directly, rather than passing
    // an override that the profile resolver correctly discards.
    await expect(runAlertTrace({...createProductionDeps(),...f.deps,gatewayServerUrl:"https://remote.invalid"},"tray",{})).rejects.toMatchObject({code:"runtime_local_only"});
  }finally{await f.close();}
});

test("installed-shape Node CLI traces the same lifecycle from journal and materialized monitor without writes",async()=>{
  const f=await fixture();try{
    const store=openMonitorStore(f.durable),epoch=randomUUID();await store.initialize();await store.begin(epoch,Date.now(),[AGENT]);
    await store.ingestEvidence({epoch,sourceKey:"c".repeat(64),expectedCursor:null,nextCursor:"one",events:f.events,atMs:Date.now()});await store.finish(epoch,Date.now());
    const before=await readFile(store.path),beforeNames=await readdir(join(f.durable,"observability"));
    const reports:unknown[]=[];
    for(const source of ["journal","monitor"]){
      const child=spawn("node",[resolve("dist/index.js"),"alerts","trace","tray","--agent",AGENT,"--from",source,"--json"],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:join(f.root,"config"),GROKBOX_RUN_ROOT:f.run,GROKBOX_BOX_RUNTIME_ROOT:f.durable},stdio:["ignore","pipe","pipe"]});
      let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);
      const status=await new Promise<number|null>((yes,no)=>{child.once("exit",yes);child.once("error",no);});expect(status,stderr).toBe(0);reports.push(JSON.parse(stdout).data.traces);
    }
    expect(reports[0]).toEqual(reports[1]);expect(await readFile(store.path)).toEqual(before);expect(await readdir(join(f.durable,"observability"))).toEqual(beforeNames);
  }finally{await f.close();}
},15000);
