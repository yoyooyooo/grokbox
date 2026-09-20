import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeProtectionChange, type ProtectionChangeRequest, type ProtectionOperation } from "../src/client.ts";
import { protectionWorker, protectionSnapshot, protectionOperation, protectionSubject } from "../src/protection-validation.ts";
const I="11111111-1111-4111-8111-111111111111",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",ref=`bot:${I}:${A}`,rev="a".repeat(64);
const request=():ProtectionChangeRequest=>({requestId:randomUUID(),expectedRevision:rev,confirmed:true,action:"set",botRef:ref,patch:{mode:"alert",pauseOnOwnershipLoss:false}});
const receipt=(r:ProtectionChangeRequest):ProtectionOperation=>({requestId:r.requestId,operationRef:`protection-operation:${I}:${"b".repeat(64)}`,targetRef:r.action==="system"?`protection-system:${I}`:r.botRef,
  state:"succeeded",beforeRevision:rev,revision:"c".repeat(64),application:"not-observed",nativeEffectsPerformed:false});
const reply=(data:unknown)=>Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:true,data});

test("protection input cannot implicitly enable, carry arbitrary fields or execute coercion accessors",()=>{
  const good=request();expect(normalizeProtectionChange(good,I)).toEqual(good);
  for(const patch of [{confirmed:false},{expectedRevision:"stale"},{botRef:`bot:${randomUUID()}:${A}`},{action:"capture"},{patch:{path:"/private"}},{patch:{handover:{automaticDelete:"true"}}},{patch:{captureIntervalMs:1}}])
    expect(()=>normalizeProtectionChange({...good,...patch},I)).toThrow();
  let calls=0;const raw={...good,patch:{get enabled(){calls++;return true;}}};expect(()=>normalizeProtectionChange(raw,I)).toThrow();expect(calls).toBe(0);
});

test("protection worker and snapshot transport never accepts invented installation or import proof",()=>{
  const worker={owner:"management-server",state:"running",reason:"active",scopeId:rev,scopeObservedAtMs:Date.now(),policyRevision:rev,targets:1,discovered:1,rosterSize:1,
    discoveryCoverage:"observed-window",startedAtMs:Date.now(),replacements:1,defaultProtection:true,nativeExecutionProven:false,bootInstalled:false};
  expect(protectionWorker(worker)).toBe(true);
  for(const patch of [{bootInstalled:true},{nativeExecutionProven:true},{targets:129},{reason:"PRIVATE_STACK"},{credentials:"secret"}])expect(protectionWorker({...worker,...patch})).toBe(false);
  const snapshot={snapshotRef:`snapshot:${I}:${rev}:${A}`,botRef:ref,revision:rev,state:"published",quality:"semantic_resume",capturedAtMs:Date.now(),contentIncluded:false,nativeImportProven:false};
  expect(protectionSnapshot(snapshot,I)).toBe(true);
  for(const patch of [{content:"PRIVATE_MATERIAL"},{nativeImportProven:true},{snapshotRef:`snapshot:${randomUUID()}:${rev}:${A}`},{quality:"full-native-success"}])expect(protectionSnapshot({...snapshot,...patch},I)).toBe(false);
});

test("successor handover links remain bounded, scoped and distinct from the pending replacement",()=>{
  const handover=`handover:${I}:${rev}:${randomUUID()}`;
  const subject={botRef:ref,currentBotRef:`bot:${I}:${B}`,previousBotRefs:[ref],generation:1,revision:3,
    ownership:null,observedAtMs:Date.now(),freshness:"fresh",lossId:null,lossAtMs:null,lastSnapshotRef:null,capturedAtMs:null,pendingHandoverRef:null,
    handoverRefs:[handover],handoverHistoryTruncated:false,lastAction:"successor_active",pause:null,eventExportPending:false,eventExportDropped:0,notificationDelivery:"not-observed"};
  expect(protectionSubject(subject,I,rev)).toBe(true);
  for(const patch of [{handoverRefs:[handover,handover]},
    {handoverRefs:[handover.replace(rev,"b".repeat(64))]},
    {handoverRefs:Array.from({length:17},()=>`handover:${I}:${rev}:${randomUUID()}`)},
    {handoverHistoryTruncated:"false"},{handoverRefs:undefined},{retirementAllowed:true}])expect(protectionSubject({...subject,...patch},I,rev)).toBe(false);
});

test("wrong protection success remains unknown with its original request and target locator",async()=>{
  const r=request();let calls=0;
  const client=new ManagementClient({baseUrl:"https://management.example.test",installationId:I,credential:async()=>"test-key",fetch:(async()=>{calls++;return reply({...receipt(r),targetRef:`bot:${I}:${B}`});}) as unknown as typeof fetch});
  await expect(client.changeProtection(r)).rejects.toMatchObject({code:"operation_unknown",details:{requestId:r.requestId,lookupPath:`/v1/protection-operations/${A}/${r.requestId}`}});
  expect(calls).toBe(1);expect(protectionOperation({...receipt(r),nativeEffectsPerformed:true},I,ref,r.requestId,rev)).toBe(false);
});

test("asynchronous credential resolution cannot change the captured protection request",async()=>{
  const r=request();let release!:()=>void,seen:any;
  const gate=new Promise<void>(done=>{release=done;});
  const client=new ManagementClient({baseUrl:"https://management.example.test",installationId:I,credential:async()=>{await gate;return "test-key";},fetch:(async(_url,init)=>{seen=JSON.parse(String(init?.body));return reply(receipt(seen));}) as typeof fetch});
  const original=structuredClone(r),pending=client.changeProtection(r);
  r.requestId=randomUUID();if(r.action==="set"){r.botRef=`bot:${I}:${B}`;r.patch.mode="auto-replace";}
  release();await pending;expect(seen).toEqual(original);
});

test("read targets are exact and response identity matches the requested recovery object",async()=>{
  let calls=0;const client=new ManagementClient({baseUrl:"https://management.example.test",installationId:I,credential:async()=>"key",fetch:(async()=>{calls++;return reply({});}) as unknown as typeof fetch});
  await expect(client.botProtection("display-name")).rejects.toMatchObject({code:"invalid_input"});
  await expect(client.protectionSnapshot(`snapshot:${randomUUID()}:${rev}:${A}`)).rejects.toMatchObject({code:"wrong_installation"});
  await expect(client.protectionOperation("system","bad-id")).rejects.toMatchObject({code:"invalid_input"});expect(calls).toBe(0);
});
