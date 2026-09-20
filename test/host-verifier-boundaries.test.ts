import { test, expect } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
test("formal Rust FD inputs and adversarial Node supervisor boundaries settle real children",async()=>{
 const cli=ensurePackedCli(),cache=join(root,"node_modules/.cache");await mkdir(cache,{recursive:true});const directory=await mkdtemp(join(cache,"verifier-boundaries-"));
 try{
 const entry=join(directory,"suite.mjs");await build({absWorkingDir:root,entryPoints:["packages/box-runtime/test/host-verifier-boundaries.node.ts"],outfile:entry,bundle:true,platform:"node",target:"node22",format:"esm",logLevel:"silent"});
 const result=spawnSync("node",["--test","--test-reporter=tap",entry],{cwd:directory,encoding:"utf8",timeout:45000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory,GROKBOX_TEST_CLI_ENTRY:cli,GROKBOX_TEST_FIXTURES:join(root,"test/fixtures")}});
 expect(result.error,`${result.stdout}\n${result.stderr}`).toBeUndefined();expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);expect(result.stdout).toMatch(/# fail 0/);expect(result.stdout).toMatch(/# skipped 0/);
 console.log(JSON.stringify({suite:"host-verifier-boundaries-node",tests:Number(/# tests (\d+)/.exec(result.stdout)?.[1]),failed:0,skipped:0}));
 }finally{await rm(directory,{recursive:true,force:true});}
},120000);
