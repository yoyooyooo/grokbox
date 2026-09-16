import { expect,test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
test("packed Node Host handles >60000 fragments with bounded replay and independent late readers",async()=>{
 const root=fileURLToPath(new URL("../../../",import.meta.url)),dir=await mkdtemp(join(tmpdir(),"fragmented-node-"));
 try{const outfile=join(dir,"probe.mjs");await build({absWorkingDir:root,entryPoints:["packages/box-runtime/test/fixtures/fragmented-stream-node.ts"],outfile,bundle:true,platform:"node",target:"node20",format:"esm",logLevel:"silent"});
 const result=spawnSync("node",[outfile],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir},encoding:"utf8",timeout:15000});
 expect(result.status,result.stderr).toBe(0);const receipt=JSON.parse(result.stdout);expect(receipt).toMatchObject({readers:2,providerAttempts:1,networkCalls:0});expect(receipt.events).toBeGreaterThan(60000);expect(receipt.replayRecords).toBeLessThan(40);
 console.log(JSON.stringify({probe:"fragmented-node",...receipt}));
 }finally{await rm(dir,{recursive:true,force:true});}
},20000);
