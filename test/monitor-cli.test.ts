import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { captureCli, writeDiscovery } from "./helpers.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";

const ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const entry=fileURLToPath(new URL("../dist/index.js",import.meta.url));
function launch(root:string,args:string[]) {
  const child=spawn("node",[entry,"runtime","monitor",...args,"--json"],{
    cwd:root,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH??"",HOME:root,LANG:"C.UTF-8",
      GROKBOX_BOX_RUNTIME_ROOT:root,GROKBOX_CONFIG_DIR:join(root,"config") },
  });
  let stdout="",stderr="",readyResolve!:(data:any)=>void;
  const ready=new Promise<any>(resolve=>{readyResolve=resolve;});
  const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    child.once("error",reject);child.once("exit",code=>resolve({code,stdout,stderr}));
  });
  child.stdout.on("data",chunk=>{
    stdout+=chunk.toString(); if(stdout.length>256*1024){child.kill("SIGTERM");return;}
    for(const line of stdout.split("\n").filter(Boolean)){try{const r=JSON.parse(line);if(r.data?.process==="monitor")readyResolve(r.data);}catch{}}
  });
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-64*1024);});
  return {child,done,ready};
}
async function bounded<T>(p:Promise<T>,ms=8000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("owned_monitor_timeout")),ms);})]);}finally{if(timer)clearTimeout(timer);}}
async function stop(p:ReturnType<typeof launch>){if(p.child.exitCode===null&&p.child.signalCode===null)p.child.kill("SIGTERM");try{await bounded(p.done);}catch(e){p.child.kill("SIGKILL");await p.done;throw e;}}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"gbox-monitor-cli-")),requests:string[]=[];
  let serverHarness:"box"|"temporal"="temporal";
  const token="owned-monitor-test-token";
  const gateway=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
    const path=new URL(req.url).pathname;
    if(path==="/health")return Response.json({ok:true,pid:4242,startedAt:1700000000000});
    expect(req.headers.get("authorization")).toBe(`Bearer ${token}`);
    requests.push(path);
    if(path!=="/api/getHostStatus")return Response.json({}, {status:404});
    const body=await req.json() as {grokboxOwnershipAgentIds:string[]};
    const snapshot=ownedOwnershipSnapshot(body.grokboxOwnershipAgentIds,{serverHarness});
    return Response.json({grokboxOwnership:snapshot,secret:"PRIVATE_SENTINEL"});
  }});
  const discoveryPath=await writeDiscovery({port:gateway.port!,pid:4242,startedAt:1700000000000,token});
  const deps={boxRuntimeRoot:root,configDir:join(root,"config"),discoveryPath,transport:"local" as const,env:{},daemonSocket:join(root,"missing.sock")};
  return {root,requests,discoveryPath,deps,set:(v:"box"|"temporal")=>{serverHarness=v;},close:async()=>{gateway.stop(true);await rm(root,{recursive:true,force:true});}};
}

test("CLI read surfaces have zero Server calls/writes; mutation requires explicit confirmation",async()=>{
  const f=await fixture();
  try{
    for(const args of [["snapshot"],["events"],["incidents"],["init"],["run","--agents",ID,"--once"]]){
      const r=await captureCli(["runtime","monitor",...args],f.deps);
      expect(r.code).not.toBe(0);
    }
    expect(f.requests).toEqual([]);expect(existsSync(join(f.root,"observability"))).toBe(false);
    expect((await captureCli(["runtime","monitor","init","--confirm"],f.deps)).code).toBe(0);
    const db=join(f.root,"observability/observations.sqlite"),before=await readFile(db),stamp=(await stat(db)).mtimeMs;
    for(const command of ["snapshot","events","incidents"]){expect((await captureCli(["runtime","monitor",command],f.deps)).code).toBe(0);}
    expect(await readFile(db)).toEqual(before);expect((await stat(db)).mtimeMs).toBe(stamp);expect(f.requests).toEqual([]);
  }finally{await f.close();}
});

test("source CLI batches observations, records conflict and management receipts across cold store opens",async()=>{
  const f=await fixture();
  try{
    await captureCli(["runtime","monitor","init","--confirm"],f.deps);
    const run=await captureCli(["runtime","monitor","run","--agents",`${ID},${B}`,"--confirm","--once"],f.deps);
    expect(run.code).toBe(0);expect(f.requests).toEqual(["/api/getHostStatus"]);
    const data=JSON.parse(run.stdout).data;
    expect(data).toMatchObject({state:"observed",productionAccepted:false,notificationMode:"local_only"});
    expect(data.snapshot.agents).toHaveLength(2);
    expect(data.changes.filter((e:any)=>e.kind==="incident_opened")).toHaveLength(2);
    expect(data.changes.every((e:any)=>typeof e.eventId==="string")).toBe(true);
    const list=JSON.parse((await captureCli(["runtime","monitor","incidents"],f.deps)).stdout).data.incidents;
    expect(list).toHaveLength(2);
    const requestId=randomUUID();
    const args=["runtime","monitor","ack",list[0].id,"--request-id",requestId,"--expected-revision","1"];
    const ack=await captureCli(args,f.deps);expect(ack.code).toBe(0);
    expect(JSON.parse(ack.stdout).data).toMatchObject({duplicate:false,repaired:false,appliedRevision:2});
    expect(JSON.parse((await captureCli(args,f.deps)).stdout).data.duplicate).toBe(true);
    expect(f.requests).toEqual(["/api/getHostStatus"]);
    expect(run.stdout+ack.stdout).not.toContain("PRIVATE_SENTINEL");
    expect(existsSync(join(f.root,"models.json"))).toBe(false);expect(existsSync(join(f.root,"state"))).toBe(false);
  }finally{await f.close();}
});

test("packaged Node init/read/ack and a fresh process preserve real SQLite observations",async()=>{
  const f=await fixture();const children:Array<ReturnType<typeof launch>>=[];
  const invoke=async(args:string[])=>{const p=launch(f.root,args);children.push(p);return bounded(p.done);};
  try{
    const initialized=await invoke(["init","--confirm"]);
    if(initialized.code!==0)throw new Error(`owned packaged init failed: ${initialized.stderr}`);
    expect(initialized.code).toBe(0);
    // Source uses the injected authenticated read; all subsequent Node clients
    // reopen only the persisted SQLite, never a test-owned in-memory database.
    expect((await captureCli(["runtime","monitor","run","--agents",ID,"--confirm","--once"],f.deps)).code).toBe(0);
    const result=await invoke(["incidents"]);expect(result.code).toBe(0);
    const incident=JSON.parse(result.stdout).data.incidents[0];
    expect(incident).toMatchObject({rule:"ownership_conflict",status:"open"});
    expect((await invoke(["ack",incident.id,"--request-id",randomUUID(),"--expected-revision","1"])).code).toBe(0);
    const second=await invoke(["incidents"]);
    expect(JSON.parse(second.stdout).data.incidents[0]).toMatchObject({acknowledged:true,status:"open"});
    expect((await readFile(join(f.root,"observability/observations.sqlite"))).subarray(0,16).toString()).toBe("SQLite format 3\u0000");
    expect(f.requests).toHaveLength(1);
    for(const p of children){const r=await p.done;expect(r.stderr).toBe("");}
  }finally{for(const p of children)await stop(p);await f.close();}
},20000);

test("one foreground collector owns sampling, concurrent reads do not poll, cancellation releases its lease",async()=>{
  const f=await fixture(),controller=new AbortController();
  let ready!:()=>void;const published=new Promise<void>(r=>{ready=r;});
  let pending:Promise<unknown>|undefined;
  try{
    await captureCli(["runtime","monitor","init","--confirm"],f.deps);
    pending=captureCli(["runtime","monitor","run","--agents",ID,"--confirm"],{
      ...f.deps,signal:controller.signal,stdout:{write(){ready();}},
    });
    await bounded(published);
    const second=await captureCli(["runtime","monitor","run","--agents",ID,"--confirm","--once"],f.deps);
    expect(second.code).not.toBe(0);expect(second.stderr).toContain("monitor_already_running_or_recovery_required");
    await Promise.all(Array.from({length:4},()=>captureCli(["runtime","monitor","snapshot"],f.deps)));
    expect(f.requests).toHaveLength(1);
    controller.abort();const stopped=await bounded(pending) as {code:number};expect(stopped.code).toBe(0);
    expect(existsSync(join(f.root,"observability/collector.lock"))).toBe(false);
    f.set("box");
    expect((await captureCli(["runtime","monitor","run","--agents",ID,"--confirm","--once"],f.deps)).code).toBe(0);
    expect(f.requests).toHaveLength(2);
    const incidents=JSON.parse((await captureCli(["runtime","monitor","incidents"],f.deps)).stdout).data.incidents;
    expect(incidents.find((i:any)=>i.rule==="ownership_conflict").status).toBe("resolved");
  }finally{controller.abort();if(pending)await bounded(pending);await f.close();}
},15000);
