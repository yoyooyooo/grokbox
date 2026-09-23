import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDesktop, DEFAULT_MIN_IDLE_MS, displayFromEnviron, inspectDesktopProc, type DesktopWorld } from "@grokbox/runtime-kernel/desktop";
import { DesktopManager, reapDeletedAgentSeat, unseatAgentFromAssignments, publishConfigFile, type DesktopIo } from "@grokbox/box-runtime/runtime";
import { isDesktopLogWrapper } from "../packages/box-runtime/src/internal/io/desktop.node.ts";
import { writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import { DAEMON_METHODS } from "../packages/cli/src/daemon/protocol.ts";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",K="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function world(overrides:Partial<DesktopWorld>={}):DesktopWorld{return {complete:true,displayIdentities:{1:"1".repeat(64),2:"2".repeat(64),3:"3".repeat(64),27:"7".repeat(64)},nowMs:2_000_000,assignments:{[A]:1,[B]:2},names:{[A]:"main",[B]:"idle-bot"},litDisplays:new Set([1,2]),displayStartedAtMs:{1:0,2:0},transcriptWrittenAtMs:{[A]:0,[B]:0},busyMarkers:new Set(),grokDisplays:new Set(),taskDisplays:new Set(),startWindowDisplays:new Set(),...overrides};}
const policy={minIdleMs:DEFAULT_MIN_IDLE_MS,minDisplayAgeMs:DEFAULT_MIN_IDLE_MS,floorAgentIds:[],keepAgentIds:[]};
test("desktop commands/RPCs are replaced, not retained as empty compatibility handlers",()=>{
  expect(LEAF_COMMANDS.some(c=>c.path[0]==="desktop")).toBe(false);expect(DAEMON_METHODS.some(m=>m.startsWith("desktop"))).toBe(false);
  for(const name of ["system desktop get","system desktop prune","system desktop keep set","system config apply"])expect(LEAF_COMMANDS.some(c=>c.path.join(" ")===name)).toBe(true);
});
test("process observations distinguish exact display, Grok, Task and startup without exec-daemon false positives",()=>{
  expect(inspectDesktopProc("/exec-daemon/node\0/exec-daemon/index.js\0serve\0--computer-use-enabled")).toEqual({grok:false,task:false,startWindow:undefined});
  expect(inspectDesktopProc("/usr/local/bin/grok\0--effort\0high").grok).toBe(true);
  expect(inspectDesktopProc(["/usr/local/bin/start-window","12"].join("\0")).startWindow).toBe(12);
  expect(inspectDesktopProc(["/usr/local/bin/start-window","12bad"].join("\0")).startWindow).toBeUndefined();
  expect(displayFromEnviron("HOME=/home/box\0DISPLAY=:10.0\0")).toBe(10);expect(displayFromEnviron("DISPLAY=:2\0DISPLAY=:3")).toBeUndefined();
});
for(const [name,overrides,reason]of [
  ["incomplete",{complete:false},"source-incomplete"], ["missing identity",{displayIdentities:{}},"source-incomplete"],
  ["duplicate seat",{assignments:{[A]:2,[B]:2}},"ambiguous-seat"], ["dark",{litDisplays:new Set([1])},"dark"],
  ["Grok",{grokDisplays:new Set([2])},"grok"], ["Task",{taskDisplays:new Set([2])},"task"],
  ["marker",{busyMarkers:new Set([2])},"busy-marker"], ["startup",{startWindowDisplays:new Set([2])},"start-window"],
  ["fresh",{displayStartedAtMs:{2:1_999_999}},"fresh-display"], ["transcript",{transcriptWrittenAtMs:{[B]:1_999_999}},"recent-transcript"],
  ["missing transcript",{transcriptWrittenAtMs:{}},"recent-transcript"],
] as const)test(`classifier retains ${name} rather than manufacturing idle`,()=>{expect(classifyDesktop(world(overrides),policy).find(v=>v.agentId===B)).toMatchObject({idle:false,busyReason:reason});});
test("main, immutable floor and explicit keep remain protected, independently of automatic permission",()=>{
  expect(classifyDesktop(world(),policy)[0]).toMatchObject({display:1,protected:true,idle:false});
  for(const protection of [{floorAgentIds:[B]},{keepAgentIds:[B]}])expect(classifyDesktop(world(),{...policy,...protection}).find(v=>v.agentId===B)).toMatchObject({protected:true,idle:false});
});
test("log cleanup cannot signal an arbitrary process because an argument mentions a desktop path",()=>{
  expect(isDesktopLogWrapper("/bin/sh\0-c\0echo /tmp/sand-window-2/foo", "/usr/bin/sh",2)).toBe(false);
  expect(isDesktopLogWrapper("/bin/tail\0-F\0/tmp/sand-window-2/foo", "/usr/bin/tail",2)).toBe(true);
  expect(isDesktopLogWrapper("/bin/tail\0-F\0/tmp/sand-window-2/../other", "/usr/bin/tail",2)).toBe(false);
  expect(isDesktopLogWrapper("/bin/tail\0-F\0/tmp/sand-window-1/foo", "/usr/bin/tail",1)).toBe(false);
});
test("original manager rejects a recreated display and does not retry a lost settlement publication",async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-manager-"));let manager:DesktopManager|undefined,current=world(),stops=0,settlements=0;
  const io:DesktopIo={readWorld:async()=>current,stopWindow:async()=>{stops++;current=world({litDisplays:new Set([1]),displayIdentities:{1:"1".repeat(64)}});},reapLogs:async()=>{},unseatAgent:async()=>{}};
  try{await writeDaemonConfig(root,{version:1,desktop:{minIdleMs:600000}});manager=await DesktopManager.create(root,()=>2_000_000,{},io);
    await manager.reclaim([{display:2,agentId:B,identity:"2".repeat(64)}],{before:async()=>{current=world({displayIdentities:{1:"1".repeat(64),2:"f".repeat(64)}});},after:async(_r,state)=>{expect(state).toBe("refused");}},false);expect(stops).toBe(0);
    current=world();await expect(manager.reclaim([{display:2,agentId:B,identity:"2".repeat(64)}],{before:async()=>{},after:async()=>{settlements++;throw Error("lost-publication");}},false)).rejects.toThrow("lost-publication");expect(stops).toBe(1);expect(settlements).toBe(1);
  }finally{await manager?.close();await rm(root,{recursive:true,force:true});}
});
test("native deletion cleanup preserves main desktop and unseats only its exact original Bot",async()=>{
  let current=world(),stops:number[]=[];const io:DesktopIo={readWorld:async()=>current,stopWindow:async d=>{stops.push(d);current.litDisplays=new Set([...current.litDisplays].filter(value=>value!==d));delete current.displayIdentities[d];},reapLogs:async()=>{},unseatAgent:async id=>{delete current.assignments[id];}};
  expect(await reapDeletedAgentSeat(A,2_000_000,io)).toEqual({display:1,outcome:"skipped_main"});expect(stops).toEqual([]);
  expect(await reapDeletedAgentSeat(B,2_000_000,io)).toEqual({display:2,outcome:"stopped"});expect(stops).toEqual([2]);expect(current.assignments[B]).toBeUndefined();
  expect(await reapDeletedAgentSeat(B,2_000_000,io)).toEqual({display:null,outcome:"no_seat"});
});
test("original seat table removal preserves unrelated native assignments and tokens, and corrupt data is not rewritten",async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-seat-")),path=join(root,"assignments.json");try{
    await writeFile(path,JSON.stringify({assignments:{[A]:1,[B]:2},tokens:{[A]:"SYNTHETIC_A",[B]:"SYNTHETIC_B"},extra:true}),{mode:0o600});
    await unseatAgentFromAssignments(path,B.toUpperCase(),2);expect(JSON.parse(await readFile(path,"utf8"))).toEqual({assignments:{[A]:1},tokens:{[A]:"SYNTHETIC_A"},extra:true});
    await writeFile(path,"{bad");await expect(unseatAgentFromAssignments(path,A,2)).rejects.toMatchObject({code:"desktop_unavailable"});expect(await readFile(path,"utf8")).toBe("{bad");
  }finally{await rm(root,{recursive:true,force:true});}
});
for(const transport of ["auto","local"] as const)for(const remote of [undefined,"ssh","url"] as const)test(`retired deletion ${transport}/${remote??"box"} cannot fall back to native deletion or desktop cleanup`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-delete-")),stops:number[]=[];let gateway:Awaited<ReturnType<typeof startMockGateway>>|undefined;
  try{gateway=await startMockGateway({agents:[{id:B,name:"idle-bot",title:"",isGroup:false,isHiddenFromSidebar:false,isRunning:false,memberIds:[]}]});const discovery=await writeDiscovery({port:gateway.port,pid:gateway.pid,startedAt:gateway.startedAt,token:gateway.token});
    await writeProfileFile(root,"box",{version:1,transport,gateway_discovery:discovery,...(remote==="ssh"?{ssh_host:"peer"}:remote==="url"?{server_url:"https://daemon.example.test"}:{})});
    const current=world();const io:DesktopIo={readWorld:async()=>current,stopWindow:async d=>{stops.push(d);current.litDisplays=new Set([...current.litDisplays].filter(value=>value!==d));delete current.displayIdentities[d];},reapLogs:async()=>{},unseatAgent:async id=>{delete current.assignments[id];}};
    const result=await captureCli(["--profile","box","agents","delete","idle-bot","--yes","--json"],{configDir:root,discoveryPath:discovery,env:{},desktopIo:io,skillsDir:join(import.meta.dir,"../skills")});
    expect(result.code,result.stderr).toBe(2);expect(stops).toEqual([]);expect(gateway.requests).toEqual([]);
  }finally{gateway?.stop();await rm(root,{recursive:true,force:true});}
});
for (const fault of ["shared", "incomplete", "recreated", "reassigned-after-stop"] as const) test(`original deletion cleanup refuses ${fault} seating without touching another owner`, async () => {
  let reads=0, stops=0, logs=0, unseats=0;
  const io:DesktopIo={readWorld:async()=>{reads++;return fault==="shared"?world({assignments:{[A]:2,[B]:2}})
    :fault==="incomplete"?world({complete:false}):fault==="recreated"&&reads>1?world({displayIdentities:{2:"f".repeat(64)}})
    :fault==="reassigned-after-stop"&&stops>0?world({assignments:{[A]:1,[K]:2}}):world();},
    stopWindow:async()=>{stops++;},reapLogs:async()=>{logs++;},unseatAgent:async()=>{unseats++;}};
  expect(await reapDeletedAgentSeat(B,2_000_000,io)).toEqual({display:2,outcome:"unavailable"});
  expect(stops).toBe(fault==="reassigned-after-stop"?1:0);expect(logs).toBe(0);expect(unseats).toBe(0);
});
