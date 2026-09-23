import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopManager, reapDeletedAgentSeat, unseatAgentFromAssignments, type DesktopIo } from "@grokbox/box-runtime/runtime";
import type { DesktopWorld } from "@grokbox/runtime-kernel/desktop";
import { readDesktopWorld, type DesktopSourcePaths } from "../packages/box-runtime/src/internal/io/desktop-source.node.ts";
import { writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const world = (): DesktopWorld => ({complete:true,nowMs:2000000,assignments:{[A]:1,[B]:2},names:{},
  litDisplays:new Set([1,2]),displayIdentities:{1:"1".repeat(64),2:"2".repeat(64)},displayStartedAtMs:{1:0,2:0},
  transcriptWrittenAtMs:{[A]:0,[B]:0},busyMarkers:new Set(),grokDisplays:new Set(),taskDisplays:new Set(),startWindowDisplays:new Set()});
function stop(current:DesktopWorld){current.litDisplays=new Set([1]);delete current.displayIdentities[2];}
for(const fault of ["recreated-after-stop","still-running-after-helper","reassigned-during-logs","recreated-during-logs","incomplete-after-stop","startup-after-stop"] as const){
  test(`deletion preserves changed resources: ${fault}`,async()=>{
    const current=world();let stops=0,logs=0,unseats=0;
    const io:DesktopIo={readWorld:async()=>structuredClone(current),stopWindow:async()=>{
      stops++;if(fault!=="still-running-after-helper")stop(current);
      if(fault==="recreated-after-stop"){current.litDisplays=new Set([1,2]);current.displayIdentities[2]="f".repeat(64);}
      if(fault==="incomplete-after-stop")current.complete=false;
      if(fault==="startup-after-stop")current.startWindowDisplays=new Set([2]);
    },reapLogs:async()=>{logs++;if(fault==="reassigned-during-logs")current.assignments[B]=3;
      if(fault==="recreated-during-logs"){current.litDisplays=new Set([1,2]);current.displayIdentities[2]="f".repeat(64);}},
    unseatAgent:async id=>{unseats++;delete current.assignments[id];}};
    expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:2,outcome:"unavailable"});
    expect(stops).toBe(1);expect(unseats).toBe(0);
    expect(logs).toBe(fault.endsWith("during-logs")?1:0);
    expect(current.assignments[B]).toBe(fault==="reassigned-during-logs"?3:2);
  });
}
test("acknowledged deletion carries exact scope/seat and independently observes completed cleanup",async()=>{
  const current=world();let stops=0,logs=0,unseats=0;
  const io:DesktopIo={readWorld:async(_now,deleted,display)=>{expect(deleted).toBe(B);if(display!==undefined)expect(display).toBe(2);return structuredClone(current);},
    stopWindow:async()=>{stops++;stop(current);},reapLogs:async()=>{logs++;},
    unseatAgent:async(id,display)=>{expect(id).toBe(B);expect(display).toBe(2);unseats++;delete current.assignments[B];}};
  expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:2,outcome:"stopped"});expect([stops,logs,unseats]).toEqual([1,1,1]);
  expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:null,outcome:"no_seat"});expect([stops,logs,unseats]).toEqual([1,1,1]);
});
for(const fault of ["ignored-unseat","failed-unseat"] as const)test(`deletion cannot claim successful ${fault}`,async()=>{
  const current=world();let attempts=0;
  const io:DesktopIo={readWorld:async()=>current,stopWindow:async()=>stop(current),reapLogs:async()=>{},unseatAgent:async()=>{attempts++;if(fault==="failed-unseat")throw Error("synthetic-unseat-failure");}};
  expect((await reapDeletedAgentSeat(B,2000000,io)).outcome).toBe("unavailable");expect(attempts).toBe(1);expect(current.assignments[B]).toBe(2);
});
for(const fault of ["different-display","ambiguous-seat","before-publication","reappeared-after-publication"] as const)test(`original seat writer preserves ${fault} and never retries removal`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-unseat-")),path=join(root,"assignments.json");let hooks=0;
  const table=(display:number)=>({assignments:{[A]:1,[B]:display},tokens:{[A]:"SYNTHETIC_A",[B]:"SYNTHETIC_NEW"},extra:true});
  try{
    const initial=fault==="ambiguous-seat"?{...table(2),assignments:{[A]:2,[B]:2}}:table(fault==="different-display"?3:2);
    await writeFile(path,JSON.stringify(initial),{mode:0o600});
    await expect(unseatAgentFromAssignments(path,B,2,{
      beforePublish:async()=>{if(fault==="before-publication"){hooks++;await writeFile(path,JSON.stringify(table(3)));}},
      afterPublish:async()=>{if(fault==="reappeared-after-publication"){hooks++;await writeFile(path,JSON.stringify(table(3)));}},
    })).rejects.toMatchObject({code:"desktop_unavailable"});
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual(fault.includes("publication")?table(3):initial);
    expect(hooks).toBe(fault.includes("publication")?1:0);
  }finally{await rm(root,{recursive:true,force:true});}
});
for(const fault of ["recreated","still-running","changed-after-logs"] as const)test(`original manager reports unknown without cleaning observed ${fault} resources`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-manager-race-"));const current=world();let logs=0;
  let manager:DesktopManager|undefined;const outcomes:string[]=[];
  const io:DesktopIo={readWorld:async()=>current,stopWindow:async()=>{if(fault!=="still-running")stop(current);if(fault==="recreated"){current.litDisplays=new Set([1,2]);current.displayIdentities[2]="f".repeat(64);}},
    reapLogs:async()=>{logs++;if(fault==="changed-after-logs")current.assignments[B]=3;},unseatAgent:async()=>{throw Error("manager-must-not-unseat");}};
  try{await writeDaemonConfig(root,{version:1,desktop:{minIdleMs:600000}});manager=await DesktopManager.create(root,()=>2000000,{},io);
    await manager.reclaim([{display:2,agentId:B,identity:"2".repeat(64)}],{before:async()=>{},after:async(_row,state)=>{outcomes.push(state);}},false);
    expect(outcomes).toEqual(["unknown"]);expect(logs).toBe(fault==="changed-after-logs"?1:0);
  }finally{await manager?.close();await rm(root,{recursive:true,force:true});}
});
test("actual scoped source permits only the acknowledged deleted transcript gap and still observes an unseated display",async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-deleted-source-"));const socket=createServer();
  const paths:DesktopSourcePaths={assignments:join(root,"assignments.json"),agents:join(root,"agents"),x11:join(root,"x11"),proc:join(root,"proc"),temporary:root};
  try{
    for(const path of [paths.agents,paths.x11,paths.proc])await mkdir(path);
    await writeFile(paths.assignments,JSON.stringify({assignments:{[B]:2},tokens:{[B]:"SYNTHETIC"}}),{mode:0o600});
    await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.listen(join(paths.x11,"X2"),resolve);});
    expect((await readDesktopWorld(2000000,paths)).complete).toBe(false);
    expect((await readDesktopWorld(2000000,paths,undefined,A)).complete).toBe(false);
    const deleted=await readDesktopWorld(2000000,paths,undefined,B,2);expect(deleted.complete).toBe(true);expect(deleted.transcriptWrittenAtMs[B]).toBeUndefined();
    await writeFile(paths.assignments,JSON.stringify({assignments:{},tokens:{}}));
    const unseated=await readDesktopWorld(2000000,paths,undefined,B,2);expect(unseated.complete).toBe(true);expect(unseated.litDisplays.has(2)).toBe(true);
    await writeFile(paths.assignments,JSON.stringify({assignments:{[B]:2},tokens:{}}));await mkdir(join(paths.agents,B));await mkdir(join(paths.agents,B,"store.db"));
    expect((await readDesktopWorld(2000000,paths,undefined,B,2)).complete).toBe(false);
  }finally{if(socket.listening)await new Promise<void>(resolve=>socket.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test("acknowledged deletion completes through actual scoped files, Unix socket shutdown and original assignment writer",async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-deletion-owned-"));const socket=createServer();let stops=0,logs=0,unseats=0;
  const paths:DesktopSourcePaths={assignments:join(root,"assignments.json"),agents:join(root,"agents"),x11:join(root,"x11"),proc:join(root,"proc"),temporary:root};
  try{
    for(const path of [paths.agents,paths.x11,paths.proc])await mkdir(path);
    await writeFile(paths.assignments,JSON.stringify({assignments:{[B]:2},tokens:{[B]:"SYNTHETIC_ORIGINAL"},unrelated:true}),{mode:0o600});
    await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.listen(join(paths.x11,"X2"),resolve);});
    const io:DesktopIo={readWorld:(now,deleted,display)=>readDesktopWorld(now,paths,undefined,deleted,display),
      stopWindow:async display=>{expect(display).toBe(2);stops++;await new Promise<void>(resolve=>socket.close(()=>resolve()));},
      reapLogs:async()=>{logs++;},unseatAgent:async(id,display)=>{unseats++;await unseatAgentFromAssignments(paths.assignments,id,display);}};
    expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:2,outcome:"stopped"});expect([stops,logs,unseats]).toEqual([1,1,1]);
    expect(JSON.parse(await readFile(paths.assignments,"utf8"))).toEqual({assignments:{},tokens:{},unrelated:true});
    expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:null,outcome:"no_seat"});expect([stops,logs,unseats]).toEqual([1,1,1]);
  }finally{if(socket.listening)await new Promise<void>(resolve=>socket.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test("final observation refuses a dark replacement seat after unseat without removing its new owner",async()=>{
  const current=world(),other="cccccccc-cccc-4ccc-8ccc-cccccccccccc";let stops=0,logs=0,unseats=0;
  const io:DesktopIo={readWorld:async()=>structuredClone(current),
    stopWindow:async()=>{stops++;stop(current);},reapLogs:async()=>{logs++;},
    unseatAgent:async(id,display)=>{expect(id).toBe(B);expect(display).toBe(2);unseats++;delete current.assignments[B];current.assignments[other]=2;}};
  expect(await reapDeletedAgentSeat(B,2000000,io)).toEqual({display:2,outcome:"unavailable"});
  expect([stops,logs,unseats]).toEqual([1,1,1]);expect(current.assignments[other]).toBe(2);
  expect(current.assignments[B]).toBeUndefined();expect(current.litDisplays.has(2)).toBe(false);
});
