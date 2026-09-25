import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../src/internal/process/helpers/grokbox-temp-supervisor.cjs", import.meta.url));
const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("actual helper preserves native umask despite a group-writable terminal default", () => {
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=fs.mkdtempSync(join(tmpdir(),'native-launch-umask-'));
process.umask(0o002);
const helper=process.argv[1],child=join(root,'child.cjs');
fs.writeFileSync(child,"const fs=require('node:fs');fs.writeFileSync(process.env.DATA,'owned');fs.writeFileSync(process.env.REPORT,JSON.stringify({umask:process.umask()}));");
const outcomes=[];
for(const mask of [0o022,0o077]) {
 const spec=join(root,'spec-'+mask+'.json'),report=join(root,'report-'+mask+'.json'),data=join(root,'data-'+mask);
 fs.writeFileSync(spec,JSON.stringify({execPath:process.execPath,argv:[child],umask:mask,env:{GROKBOX_OPERATION_ID:'owned',REPORT:report,DATA:data}}));
 const owner=spawn(process.execPath,[helper,spec],{stdio:'ignore'}),closed=once(owner,'close');
 try {
  const start=Date.now();let receipt;
  while(Date.now()-start<3000){try{receipt=JSON.parse(fs.readFileSync(spec+'.child.json','utf8'));if(receipt.exitCode===0)break;}catch{}await delay(10);}
  assert.equal(receipt?.exitCode,0);assert.equal(JSON.parse(fs.readFileSync(report,'utf8')).umask,mask);
  const mode=fs.statSync(data).mode&0o777;assert.equal(mode,0o666&~mask);outcomes.push({mask,mode,childExited:true});
 } finally {owner.kill('SIGTERM');await closed;}
}
for(const mask of [null,-1,0o1000]) {
 const spec=join(root,'invalid-'+mask+'.json');fs.writeFileSync(spec,JSON.stringify({execPath:process.execPath,argv:[child],umask:mask,env:{}}));
 const result=spawnSync(process.execPath,[helper,spec],{stdio:'ignore',timeout:3000});assert.equal(result.status,2);assert.equal(fs.existsSync(spec+'.child.json'),false);
}
assert.equal(process.umask(),0o002);console.log(JSON.stringify({outcomes,helpersJoined:true,invalidRefused:true}));
`;
  const result = spawnSync("node", ["--input-type=module", "-e", script, helper], { encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcomes: [{ mask: 0o022, mode: 0o644, childExited: true },
    { mask: 0o077, mode: 0o600, childExited: true }], helpersJoined: true, invalidRefused: true });
});
