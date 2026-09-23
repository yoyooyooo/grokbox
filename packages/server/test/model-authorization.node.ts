import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES } from '@grokbox/client';
import { openRuntimeStore } from '@grokbox/box-runtime/runtime';
import { applyUse, parseModelsFile } from '@grokbox/runtime-kernel/selection';
import { modelConfigurationRevision } from '@grokbox/runtime-kernel/model-management';
import { startManagementServer, type AccessGrant, type ManagementNative } from '../src/server.ts';
import { ownedOwnershipReader } from '../../box-runtime/test/ownership-fixture.ts';

const I='11111111-1111-4111-8111-111111111111', A='22222222-2222-4222-8222-222222222222';
const token='audit-synthetic-only-no-real-credential';
for (const mode of ['unchanged','revoke-models-write','change-principal'] as const) {
  test(`model change final authorization after native ownership wait: ${mode}`, { timeout: 15000 }, async () => {
    const root=await mkdtemp(join(tmpdir(),'grokbox-audit-model-auth-'));
    const store=openRuntimeStore(root,{});
    await store.saveModels(applyUse(parseModelsFile({version:3,models:{},assignments:{main:null,agents:{}}}),'stub/echo'));
    let enter!:()=>void, resume!:()=>void;
    const entered=new Promise<void>(r=>enter=r), continued=new Promise<void>(r=>resume=r);
    let reads=0;
    let grants:AccessGrant[]=[{tokenSha256:createHash('sha256').update(token).digest('hex'),principalId:'owner',capabilities:[...CAPABILITIES]}];
    const realFixture=ownedOwnershipReader(process.pid);
    const native:ManagementNative={
      listBots:async()=>({bots:[{id:A,name:'Synthetic',title:null,description:null,nativeHarness:'box',hidden:false,running:false,runningTurn:false,updatedAt:null,textTruncated:false,truncatedFields:[]}],source:{kind:'native-gateway',generation:'a'.repeat(64),pid:process.pid,startedAt:1,observedAt:Date.now()},coverage:'current-snapshot'}),
      ownershipRead:async(...args)=>{enter();await continued;return realFixture(...args);},
    };
    const server=await startManagementServer({store,installationId:I,native,env:{},readGrants:async()=>{reads++;return structuredClone(grants);}}, {hostHealth:{enabled:false}});
    try {
      const before=await readFile(join(root,'models.json'),'utf8');
      const body={requestId:randomUUID(),expectedRevision:modelConfigurationRevision(await store.loadModels()),change:{kind:'bot-selection',agentId:A,selection:{kind:'default'}}};
      const responsePromise=fetch(`${server.url}/v1/model-changes`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-grokbox-installation-id':I},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      await entered;
      if(mode==='revoke-models-write')grants[0]!.capabilities=grants[0]!.capabilities.filter(c=>c!=='models.write');
      if(mode==='change-principal')grants[0]!.principalId='different-owner';
      resume();
      const response=await responsePromise, result=await response.json() as any;
      const changed=(await readFile(join(root,'models.json'),'utf8'))!==before;
      console.log(JSON.stringify({audit:'model-final-authorization',mode,status:response.status,ok:result.ok,operationState:result.data?.state??null,policyReads:reads,modelFileChanged:changed,dependencyReality:'actual-node-http-effect-files; synthetic-native-ownership; stub-model; no-provider'}));
      if(mode==='unchanged'){assert.equal(response.status,200);assert.equal(changed,true);}
      else {assert.equal(changed,false,'revoked or rebound principal must not publish model configuration after the ownership wait');assert.ok([401,403].includes(response.status));}
    } finally {resume();await server.close();await rm(root,{recursive:true,force:true});}
  });
}
