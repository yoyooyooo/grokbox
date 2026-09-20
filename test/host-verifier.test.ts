import { test, expect } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
test("real verifier protocol, FD, cancellation, close and parent death contracts use packaged Rust and Node",async()=>{
 const cli=ensurePackedCli();await mkdir(join(root,"node_modules/.cache"),{recursive:true});const dir=await mkdtemp(join(root,"node_modules/.cache/verifier-test-"));
 try{
  const entry=join(dir,"suite.mjs");await build({absWorkingDir:root,entryPoints:["packages/box-runtime/test/host-verifier.node.ts"],outfile:entry,bundle:true,platform:"node",target:"node22",format:"esm",logLevel:"silent"});
  const r=spawnSync("node",["--test","--test-reporter=tap",entry],{cwd:dir,timeout:60000,encoding:"utf8",maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir,GROKBOX_TEST_CLI_ENTRY:cli,GROKBOX_TEST_FIXTURES:join(root,"test/fixtures")}});
  expect(r.error,`${r.stdout}\n${r.stderr}`).toBeUndefined();expect(r.status,`${r.stdout}\n${r.stderr}`).toBe(0);expect(r.stdout).toMatch(/# skipped 0/);
  console.log(JSON.stringify({suite:"host-verifier-node",tests:Number(r.stdout.match(/# tests (\d+)/)?.[1]),failed:0,skipped:0,artifact:"packaged"}));
 }finally{await rm(dir,{recursive:true,force:true});}
},160000);
