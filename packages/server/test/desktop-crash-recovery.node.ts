import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { startManagementServer } from "@grokbox/server";
import { openRuntimeStore, desktopOperationKey } from "@grokbox/box-runtime/runtime";
import { desktopWorld, DESKTOP_INSTALLATION as I, DESKTOP_OWNER } from "../../../apps/web/test/desktop-fixture.ts";
for(const stage of ["claim","dispatch","effect"])test(`real management process SIGKILL after ${stage} preserves the original unknown without another stop`,async()=>{
  const entry=process.env.GROKBOX_DESKTOP_CRASH_ENTRY;assert.ok(entry);
  const child=spawn("node",[entry],{stdio:["ignore","ignore","pipe","ipc"],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,GROKBOX_DESKTOP_CRASH_STAGE:stage}});
  let directory:string|undefined,server:Awaited<ReturnType<typeof startManagementServer>>|undefined,stderr="";
  child.stderr?.on("data",b=>{stderr+=b;if(stderr.length>16384)child.kill("SIGKILL");});
  const message=(phase:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{child.off("message",read);reject(Error(`No ${phase}: ${stderr}`));},10000);const read=(v:any)=>{if(v?.phase===phase){clearTimeout(timer);child.off("message",read);resolve(v);}};child.on("message",read);});
  try{const ready=await message("ready");directory=ready.directory;const client=new ManagementClient({baseUrl:ready.url,installationId:I,credential:async()=>DESKTOP_OWNER,timeoutMs:20000});const view=(await client.desktop()).data,requestId=randomUUID();
    const reached=message(stage),call=client.pruneDesktop({requestId,expectedRevision:view.revision!,confirmed:true}).catch(e=>e);await reached;const closed=once(child,"close");child.kill("SIGKILL");await closed;assert.equal((await call).code,"operation_unknown");
    const path=join(ready.root,"state/desktop",desktopOperationKey(I,"owner",requestId),"receipt.json"),raw=await readFile(path);assert.equal(JSON.parse(raw.toString()).receipt.state,"unknown");
    let stops=0;server=await startManagementServer({store:openRuntimeStore(ready.root,{}),installationId:I,native:{listBots:async()=>{throw Error("no-native");},ownershipRead:async()=>{throw Error("no-native");}},readGrants:async()=>[{principalId:"owner",capabilities:[...CAPABILITIES],tokenSha256:createHash("sha256").update(DESKTOP_OWNER).digest("hex")}],env:{}},{hostHealth:{enabled:false},desktop:{io:{readWorld:async()=>desktopWorld(),stopWindow:async()=>{stops++;},reapLogs:async()=>{},unseatAgent:async()=>{throw Error("no-unseat");}}}});
    const after=new ManagementClient({baseUrl:server.url,installationId:I,credential:async()=>DESKTOP_OWNER});assert.equal((await after.desktopOperation(requestId)).data.state,"unknown");assert.deepEqual(await readFile(path),raw);
    await assert.rejects(after.pruneDesktop({requestId:randomUUID(),expectedRevision:(await after.desktop()).data.revision!,confirmed:true}),(e:any)=>e.code==="operation_unknown");assert.equal(stops,0);
    assert.equal(await readFile(join(ready.root,"helper-effect"),"utf8").catch(()=>"absent"),stage==="effect"?"one":"absent");
  }finally{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,"close");child.kill("SIGKILL");await closed;}await server?.close();if(directory)await rm(directory,{recursive:true,force:true});}
});
