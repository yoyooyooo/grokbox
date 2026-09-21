import { expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botWorkflowRequest, continuityId, recordInbound } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../src/internal/io/continuity-workflows.node.ts";
import { openBotConvergence } from "../src/internal/roots/bot-convergence.runtime.ts";

const old = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scopeId = "a".repeat(64);
test("convergence requires activation, preserves gaps and fences missing or revoked deletion authority", async () => {
  const root=await mkdtemp(join(tmpdir(),"continuity-convergence-"));
  try {
    const db=continuityWorkflowPrograms({durableRoot:root,scopeId}); await Effect.runPromise(db.initialize());
    const operationId=randomUUID(),request=botWorkflowRequest({version:1,operationId,scopeId,kind:"replace",sourceId:old,
      profile:{name:"successor"},modelRef:null,instructions:"",snapshotId:null,activate:true,start:false,maxRunMs:1000,policyRevision:"b".repeat(64),
      handover:{automaticDelete:true,minGraceMs:60000,quietMs:60000}});
    await Effect.runPromise(db.create(request)); await Effect.runPromise(db.beginStep(operationId,"create"));
    await Effect.runPromise(db.completeStep(operationId,"create",{agentId:target,created:true,started:false}));
    await Effect.runPromise(db.phase(operationId,"active_with_handover"));
    let fail=false,deletes=0,now=Date.now()+120000,allowed=true,fence=false,revokeClaim=false;
    const control=openBotConvergence({durableRoot:root,scopeId,native:{authorize:async()=>allowed,
      observe:async()=>{if(fail)throw Error("unavailable");return {cursor:"c".repeat(64),observedAtMs:now,newMessages:0,contiguous:true,state:{lastEntryId:"last"},
        targetUsable:true,dependenciesVerified:true,resourcesIndependent:true,deletionFenceAvailable:fence};},
      delete:async()=>{deletes++;return {deleted:true,proof:"not-permitted"};}}},
      {afterCommit:async label=>{if(revokeClaim&&label==="control-transition")allowed=false;}});
    await expect(control.observe(operationId)).rejects.toThrow("not_prepared");
    expect(await Effect.runPromise(db.subject(continuityId(operationId,"inbound-watermark")))).toBeNull();
    await Effect.runPromise(db.beginStep(operationId,"initialize")); await Effect.runPromise(db.completeStep(operationId,"initialize",{state:"prepared"}));
    await Effect.runPromise(db.beginStep(operationId,"activate")); await Effect.runPromise(db.completeStep(operationId,"activate",{state:"released"}));
    await control.observe(operationId); now+=60000;
    const quiet=await control.observe(operationId);
    expect(quiet.assessment.blockers).toContain("deletion_boundary_unavailable");
    expect(await control.retire(operationId,quiet.evidenceHash,"automatic")).toMatchObject({state:"blocked"}); expect(deletes).toBe(0);
    fail=true;
    const gap=await control.observe(operationId);
    expect(gap.watermark).toMatchObject({gap:true,healthySinceMs:null,coverage:"partial"});
    expect((await Effect.runPromise(db.subject(continuityId(operationId,"inbound-watermark"))))?.data.watermark.gap).toBe(true);
    fail=false;fence=true;now=gap.watermark.lastObservedAtMs+60000;await control.observe(operationId);now+=60000;
    const ready=await control.observe(operationId);expect(ready.assessment.automaticDeleteAuthorized).toBe(true);
    revokeClaim=true;await expect(control.retire(operationId,ready.evidenceHash,"automatic")).rejects.toThrow("policy_changed");
    expect(deletes).toBe(0);expect((await Effect.runPromise(db.control(continuityId(operationId,"retire-source"))))?.state).toBe("effect_unknown");
    allowed=true;revokeClaim=false;const retained=(await Effect.runPromise(db.subject(continuityId(operationId,"inbound-watermark"))))!.data.receipt;
    expect(await control.retire(operationId,retained.evidenceHash,"automatic")).toMatchObject({state:"unknown"});expect(deletes).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("retirement reconciliation has no native calls and consumes only the exact original durable deletion receipt",async()=>{
 const root=await mkdtemp(join(tmpdir(),"retirement-reconcile-"));
 try{
  const db=continuityWorkflowPrograms({durableRoot:root,scopeId});await Effect.runPromise(db.initialize());
  const operationId=randomUUID(),request=botWorkflowRequest({version:1,operationId,scopeId,kind:"replace",sourceId:old,
    profile:{name:"successor"},modelRef:null,instructions:"",snapshotId:null,activate:true,start:false,maxRunMs:1000,policyRevision:"b".repeat(64)});
  await Effect.runPromise(db.create(request));await Effect.runPromise(db.beginStep(operationId,"create"));await Effect.runPromise(db.completeStep(operationId,"create",{agentId:target,created:true,started:false}));
  let reads=0,deletes=0;const control=openBotConvergence({durableRoot:root,scopeId,native:{authorize:async()=>{reads++;throw Error("must not contact native");},observe:async()=>{reads++;throw Error("must not sample");},delete:async()=>{deletes++;throw Error("must not delete");}}});
  expect(await control.reconcileRetirement(operationId,"explicit")).toMatchObject({state:"not-dispatched"});
  const id=continuityId(operationId,"retire-source");await Effect.runPromise(db.reserveControl(id,old,"retire-source",{operationId,targetId:target,authorization:"explicit"}));
  expect(await control.reconcileRetirement(operationId,"explicit")).toMatchObject({state:"unknown"});
  await Effect.runPromise(db.transitionControl(id,"prepared","effect_unknown",null));
  expect(await control.reconcileRetirement(operationId,"explicit")).toMatchObject({state:"unknown"});
  await Effect.runPromise(db.transitionControl(id,"effect_unknown","complete",{state:"retired",operationId,sourceDeleted:true,proof:"fixture-original-deletion-receipt"}));
  await expect(control.reconcileRetirement(operationId,"automatic")).rejects.toThrow("integrity_failure");
  expect(await control.reconcileRetirement(operationId,"explicit")).toMatchObject({state:"retired",sourceDeleted:true});
  expect((await Effect.runPromise(db.status(operationId))).phase).toBe("retired");
  expect(await control.reconcileRetirement(operationId,"explicit")).toMatchObject({state:"retired"});expect(reads).toBe(0);expect(deletes).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("a long observer outage cannot be counted as quiet even when the next transcript cursor still exists",()=>{
  const first=recordInbound(null,{cursor:"a".repeat(64),observedAtMs:1000,newMessages:0,contiguous:true});
  const resumed=recordInbound(first,{cursor:"a".repeat(64),observedAtMs:200000,newMessages:0,contiguous:true});
  expect(resumed).toMatchObject({gap:true,healthySinceMs:null,coverage:"partial"});
  const healthy=recordInbound(resumed,{cursor:"b".repeat(64),observedAtMs:210000,newMessages:0,contiguous:true});
  expect(healthy.healthySinceMs).toBe(210000);
});
