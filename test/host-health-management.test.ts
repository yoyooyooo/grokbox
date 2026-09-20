import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
test("management Host health uses actual Rust/FD analysis, original provenance and OBS, with no native Bot",async()=>{
 const cli=ensurePackedCli(),cache=join(root,"node_modules/.cache");await mkdir(cache,{recursive:true});const dir=await mkdtemp(join(cache,"host-health-"));
 try{
  const entry=join(dir,"suite.mjs");await build({absWorkingDir:root,entryPoints:["packages/server/test/host-health.node.ts"],outfile:entry,bundle:true,platform:"node",target:"node22",format:"esm",external:["classic-level","sqlite3"],banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},logLevel:"silent"});
  const r=spawnSync("node",["--test","--test-reporter=tap",entry],{cwd:dir,encoding:"utf8",timeout:90000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir,GROKBOX_TEST_CLI_ENTRY:cli,GROKBOX_TEST_FIXTURES:join(root,"test/fixtures"),GROKBOX_TEST_NATIVE_HOST:"0",GROKBOX_TEST_ALLOW_NATIVE:"0"}});
  expect(r.error,`${r.stdout}\n${r.stderr}`).toBeUndefined();expect(r.status,`${r.stdout}\n${r.stderr}`).toBe(0);expect(r.stdout).toMatch(/# fail 0/);expect(r.stdout).toMatch(/# skipped 0/);
  console.log(JSON.stringify({suite:"host-health-management-node",tests:Number(r.stdout.match(/# tests (\d+)/)?.[1]),failed:0,skipped:0,verifier:"actual-packed-Rust",nativeFacts:"public-synthetic"}));
 }finally{await rm(dir,{recursive:true,force:true});}
},180000);
