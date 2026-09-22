import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
test("managed named-root files reuse original descriptors and material safety transactions in actual Node",async()=>{
  const cli=ensurePackedCli(),cache=join(root,"node_modules/.cache");await mkdir(cache,{recursive:true});const directory=await mkdtemp(join(cache,"file-management-"));
  try{
    const entry=join(directory,"suite.mjs"),crash=join(directory,"crash.mjs");
    await build({absWorkingDir:root,entryPoints:["packages/server/test/file-crash.node.ts"],outfile:crash,bundle:true,platform:"node",target:"node22",format:"esm",external:["classic-level","sqlite3"],banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},logLevel:"silent"});
    await build({absWorkingDir:root,entryPoints:["packages/server/test/files.node.ts"],outfile:entry,bundle:true,platform:"node",target:"node22",format:"esm",external:["classic-level","sqlite3"],banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},logLevel:"silent"});
    const result=spawnSync("node",["--test","--test-reporter=tap",entry],{cwd:directory,encoding:"utf8",timeout:60000,maxBuffer:3*1024*1024,env:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory,GROKBOX_TEST_CLI_ENTRY:cli,GROKBOX_TEST_FILE_CRASH_WORKER:crash,GROKBOX_TEST_NATIVE_HOST:"0",GROKBOX_TEST_ALLOW_NATIVE:"0"}});
    expect(result.error).toBeUndefined();expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);expect(result.stdout).toMatch(/# fail 0/);expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({suite:"file-management-node",tests:Number(result.stdout.match(/# tests (\d+)/)?.[1]),failed:0,skipped:0,filesystem:"disposable-real",native:"none"}));
  }finally{await rm(directory,{recursive:true,force:true});}
},90000);
