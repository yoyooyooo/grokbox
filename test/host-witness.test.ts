import { test, expect } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
test("packed native metadata challenge and actual hook boundaries reach shared health and OBS",async()=>{
 const cli=ensurePackedCli(),temp=await mkdtemp(join(root,"node_modules/.cache/host-witness-"));
 try{
  const entry=join(temp,"test.mjs");await build({absWorkingDir:root,entryPoints:["packages/box-runtime/test/host-witness.node.ts"],outfile:entry,bundle:true,platform:"node",target:"node22",format:"esm",external:["classic-level","sqlite3"],
   banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"},logLevel:"silent"});
  const result=spawnSync("node",["--test","--test-reporter=tap",entry],{cwd:temp,encoding:"utf8",timeout:150000,maxBuffer:4*1024*1024,
   env:{PATH:process.env.PATH,HOME:temp,GROKBOX_TEST_CLI_ENTRY:cli,GROKBOX_TEST_FIXTURES:join(root,"test/fixtures")}});
  expect(result.error,result.error?.message).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.stdout).toMatch(/# fail 0/);expect(result.stdout).toMatch(/# skipped 0/);
  console.log(JSON.stringify({suite:"host-witness-node",tests:Number(result.stdout.match(/# tests (\d+)/)?.[1]),failed:0,skipped:0,artifact:"actual-packed-preload",nativeFacts:"public-synthetic"}));
 }finally{await rm(temp,{recursive:true,force:true});}
},180000);
