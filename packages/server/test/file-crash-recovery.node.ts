import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type FileChange } from "@grokbox/client";
import { fileFixture, FILE_OWNER, FILE_INSTALLATION as I } from "../../../apps/web/test/file-fixture.ts";
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
for(const phase of ["claim","publication"])test(`real packed Server SIGKILL after ${phase} preserves the original unknown and prevents redispatch`,async()=>{
  const f=await fileFixture(),worker=process.env.GROKBOX_TEST_FILE_CRASH_WORKER;assert.ok(worker);await f.server.close();
  const child=spawn("node",[worker,f.root,phase],{cwd:f.directory,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.directory}}),closed=once(child,"close");
  let out="",err="";child.stdout.on("data",b=>{out+=b;});child.stderr.on("data",b=>{err+=b;});
  const timeout=setTimeout(()=>child.kill("SIGKILL"),15000);
  try{
    const deadline=Date.now()+5000;while(!out.includes('"ready"')&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,5));
    const ready=out.split("\n").filter(Boolean).map(s=>JSON.parse(s)).find(r=>r.phase==="ready");assert.ok(ready,err);
    const api=new ManagementClient({baseUrl:ready.url,installationId:I,credential:async()=>FILE_OWNER});
    const r:FileChange={action:"write",ref:f.ref("original.txt"),requestId:randomUUID(),expectedRevision:null,confirmed:true,content:"once"};
    await rejects(api.changeFile(r),"operation_unknown");const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,"SIGKILL");assert.equal(err,"");
    assert.ok(out.includes(`"${phase}"`));await f.restart();
    assert.equal((await f.client().fileOperation(r.requestId)).data.state,"unknown");await rejects(f.client().changeFile(r),"operation_unknown");
    const expected=phase==="claim"?null:createHash("sha256").update("once").digest("hex");
    await rejects(f.client().changeFile({...r,requestId:randomUUID(),expectedRevision:expected,content:"replacement"}),"operation_unknown");
    if(phase==="claim")assert.ok(!(await readdir(f.files)).includes("original.txt"));else assert.equal(await readFile(join(f.files,"original.txt"),"utf8"),"once");
  }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;await f.close();}
});
