import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, chmod, lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { readDesktopWorld, type DesktopSourcePaths } from "../../box-runtime/src/internal/io/desktop-source.node.ts";
import { runStopWindow } from "../../box-runtime/src/internal/io/desktop.node.ts";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function source(){
  const root=await mkdtemp("/tmp/gds-"),paths:DesktopSourcePaths={assignments:join(root,"assignments.json"),agents:join(root,"agents"),x11:join(root,"x11"),proc:join(root,"proc"),temporary:root};
  for(const p of [paths.agents,join(paths.agents,A),paths.x11,paths.proc])await mkdir(p,{mode:0o700});
  await writeFile(paths.assignments,JSON.stringify({assignments:{[A]:2},tokens:{[A]:"PRIVATE_SEAT_TOKEN"}}),{mode:0o600});await writeFile(join(paths.agents,A,"store.db"),"synthetic-mtime-only");
  const socket=createServer();await new Promise<void>((r,j)=>{socket.once("error",j);socket.listen(join(paths.x11,"X2"),r);});
  return {root,paths,close:async()=>{await new Promise<void>(r=>socket.close(()=>r()));await rm(root,{recursive:true,force:true});}};
}
test("real source reader distinguishes absent/corrupt seating, transcript gaps and an actual Unix display identity",async()=>{
  const f=await source();try{
    const current=await readDesktopWorld(Date.now()+1_000_000,f.paths);assert.ok(current.complete);assert.ok(current.litDisplays.has(2));assert.match(current.displayIdentities[2]!,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(current).includes("PRIVATE_SEAT_TOKEN"));
    await rm(join(f.paths.agents,A,"store.db"));const gap=await readDesktopWorld(Date.now(),f.paths);assert.equal(gap.complete,false);assert.equal(gap.transcriptWrittenAtMs[A],gap.nowMs);
    await writeFile(f.paths.assignments,"{bad");await assert.rejects(readDesktopWorld(Date.now(),f.paths));
    await rm(f.paths.assignments);await assert.rejects(readDesktopWorld(Date.now(),f.paths));
  }finally{await f.close();}
});
test("unreadable process evidence and symlinked data are coverage failures, not quiet desktop observations",async()=>{
  const f=await source();try{
    const process=join(f.paths.proc,"77");await mkdir(process);await writeFile(join(process,"stat"),`77 (fixture) S ${Array(18).fill("0").join(" ")} 123 0\n`);await writeFile(join(process,"cmdline"),"/bin/grok\0");await writeFile(join(process,"environ"),"DISPLAY=:2\0PRIVATE_ENV=not-returned");
    let current=await readDesktopWorld(Date.now()+1_000_000,f.paths);assert.equal(current.complete,true);assert.ok(current.grokDisplays.has(2));
    await rm(join(process,"environ"));await mkdir(join(process,"environ"));current=await readDesktopWorld(Date.now(),f.paths);assert.equal(current.complete,false);
    await rm(process,{recursive:true});const table=join(f.root,"table.json");await rename(f.paths.assignments,table);await symlink(table,f.paths.assignments);await assert.rejects(readDesktopWorld(Date.now(),f.paths));
  }finally{await f.close();}
});
for(const change of ["assignment","display"] as const)test(`a ${change} replacement during process inspection is an incomplete observation, never an idle snapshot`,async()=>{
  const f=await source();let replacement:ReturnType<typeof createServer>|undefined;
  const probe=await open(f.paths.assignments,"r"),prototype=Object.getPrototypeOf(probe) as {read:typeof probe.read},original=prototype.read;await probe.close();
  try{
    const proc=join(f.paths.proc,"88");await mkdir(proc);await writeFile(join(proc,"stat"),`88 (fixture) S ${Array(18).fill("0").join(" ")} 123 0\n`);
    await writeFile(join(proc,"cmdline"),"/bin/fixture\0");await writeFile(join(proc,"environ"),"DISPLAY=:2\0");let changed=false;
    prototype.read=(async function(this:typeof probe,...args:unknown[]){
      const result=await original.apply(this,args as never);
      if(!changed&&await readlink(`/proc/self/fd/${this.fd}`)===join(proc,"cmdline")){
        changed=true;
        if(change==="assignment")await writeFile(f.paths.assignments,JSON.stringify({assignments:{[A]:3}}),{mode:0o600});
        else{await rename(join(f.paths.x11,"X2"),join(f.paths.x11,"X2-original"));replacement=createServer();await new Promise<void>((r,j)=>{replacement!.once("error",j);replacement!.listen(join(f.paths.x11,"X2"),r);});}
      }
      return result;
    }) as typeof probe.read;
    const observation=await readDesktopWorld(Date.now()+1_000_000,f.paths);assert.ok(changed);assert.equal(observation.complete,false);
  }finally{prototype.read=original;if(replacement)await new Promise<void>(r=>replacement!.close(()=>r()));await f.close();}
});
test("real helper signalled exit never counts as success and cancellation waits for its owned child close",async()=>{
  const root=await mkdtemp("/tmp/gdh-");try{
    const interrupted=join(root,"interrupted.sh");await writeFile(interrupted,"#!/bin/sh\nkill -TERM $$\n",{mode:0o700});
    await assert.rejects(runStopWindow(interrupted,2),{code:"desktop_unavailable"});
    await assert.rejects(runStopWindow(interrupted,1),{code:"desktop_unavailable"});
    const done=join(root,"done.sh");await writeFile(done,"#!/bin/sh\nexit 0\n",{mode:0o700});await runStopWindow(done,2);
    const waiting=join(root,"waiting.sh");await writeFile(waiting,`#!/bin/sh\nexec '${process.execPath}' -e 'setInterval(()=>{},1000)'\n`,{mode:0o700});
    const controller=new AbortController(),run=runStopWindow(waiting,2,controller.signal);const timer=setTimeout(()=>controller.abort(),40);try{await assert.rejects(run,{code:"desktop_unavailable"});}finally{clearTimeout(timer);}
  }finally{await rm(root,{recursive:true,force:true});}
});
