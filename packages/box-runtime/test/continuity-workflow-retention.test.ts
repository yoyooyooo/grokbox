import { expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { botWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
import { continuityWorkflowPrograms } from "../src/internal/io/continuity-workflows.node.ts";
import { CONT_SCOPE, CONT_AGENT, materialFixture } from "./fixtures/continuity-material.ts";

test("workflow and subject reservations protect material in the same real GC transaction, before publication and across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-workflow-gc-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE }); await store.initialize();
    const workflows = continuityWorkflowPrograms({ durableRoot: root, scopeId: CONT_SCOPE });
    const operationId = randomUUID(), first = materialFixture("source", 1), pending = materialFixture("pending", 2), ordinary = materialFixture("ordinary", 3);
    const request = botWorkflowRequest({ version: 1, kind: "clone", operationId, scopeId: CONT_SCOPE, sourceId: CONT_AGENT,
      profile: { name: "test" }, modelRef: null, instructions: "", snapshotId: first.requestId, activate: false, start: false,
      maxRunMs: 1000, policyRevision: "c".repeat(64) });
    await Effect.runPromise(workflows.create(request));
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT, 0, CONT_AGENT, 0, { pendingSnapshotId: pending.requestId }));
    for (const publication of [first, pending, ordinary, materialFixture("fourth", 4), materialFixture("fifth", 5)]) await store.publish(publication);
    const reopened = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE });
    await reopened.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await reopened.readSnapshot(first.requestId)).reference.ref).toBe(first.requestId);
    expect((await reopened.readSnapshot(pending.requestId)).reference.ref).toBe(pending.requestId);
    await expect(reopened.readSnapshot(ordinary.requestId)).rejects.toThrow();
    await Effect.runPromise(workflows.phase(operationId, "retired"));
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT, 1, CONT_AGENT, 0, {}));
    await reopened.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    await expect(reopened.readSnapshot(first.requestId)).rejects.toThrow();
    await expect(reopened.readSnapshot(pending.requestId)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capture completion atomically preserves newer loss observations and pins only its original subject generation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"continuity-capture-association-"));
  try{
    const store=openContinuityRecoveryStore({durableRoot:root,scopeId:CONT_SCOPE});await store.initialize();
    const workflows=continuityWorkflowPrograms({durableRoot:root,scopeId:CONT_SCOPE}),capture=materialFixture("captured",1),lossId=randomUUID();
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT,0,CONT_AGENT,0,{pendingSnapshotId:capture.requestId,lastState:"box"}));
    await store.publish(capture);
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT,1,CONT_AGENT,0,{pendingSnapshotId:capture.requestId,lastState:"temporal",lossId,nextEventSequence:3,eventPending:{id:lossId,sequence:2}}));
    const completion={logicalId:CONT_AGENT,currentId:CONT_AGENT,generation:0,requestId:capture.requestId,snapshotId:capture.requestId,capturedAtMs:Date.now(),archive:false};
    expect(await Effect.runPromise(workflows.completeSubjectCapture(completion))).toBe("snapshot_saved");
    const saved=await Effect.runPromise(workflows.subject(CONT_AGENT));
    expect(saved?.data).toMatchObject({lastState:"temporal",lossId,nextEventSequence:3,eventPending:{id:lossId,sequence:2},lastSnapshotId:capture.requestId,pendingSnapshotId:null});
    for(let i=2;i<6;i++)await store.publish(materialFixture(`newer-${i}`,i));
    await store.owners.recovery.maintain({nowMs:Date.now(),maxItems:64});expect((await store.readSnapshot(capture.requestId)).reference.ref).toBe(capture.requestId);
    const target=randomUUID(),pending=randomUUID();
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT,saved!.revision,target,1,{pendingSnapshotId:pending}));
    const before=await Effect.runPromise(workflows.subject(CONT_AGENT));
    expect(await Effect.runPromise(workflows.completeSubjectCapture(completion))).toBe("superseded");
    expect(await Effect.runPromise(workflows.subject(CONT_AGENT))).toEqual(before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("default protection excludes unfinished targets and replacement lineage, but admits completed independent clones and startups", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-enrollment-"));
  try {
    const db = continuityWorkflowPrograms({ durableRoot: root, scopeId: CONT_SCOPE }); await Effect.runPromise(db.initialize());
    for (const kind of ["clone", "spawn", "replace"] as const) {
      const operationId = randomUUID(), targetId = randomUUID();
      const r = botWorkflowRequest({ version: 1, kind, operationId, scopeId: CONT_SCOPE, sourceId: kind === "spawn" ? null : CONT_AGENT,
        profile: { name: "Owned lifecycle test" }, modelRef: null, instructions: "", snapshotId: null,
        activate: kind !== "clone", start: kind === "spawn", maxRunMs: 1000, policyRevision: "c".repeat(64) });
      await Effect.runPromise(db.create(r)); await Effect.runPromise(db.beginStep(operationId, "create"));
      expect((await Effect.runPromise(db.enrollment())).unknownCreations).toBe(1);
      await Effect.runPromise(db.completeStep(operationId, "create", { agentId: targetId, created: true, started: false }));
      expect((await Effect.runPromise(db.enrollment())).targets).toContain(targetId);
      const final = kind === "spawn" ? "startup" : kind === "clone" ? "initialize" : "handover";
      await Effect.runPromise(db.beginStep(operationId, final)); await Effect.runPromise(db.completeStep(operationId, final, { state: "test-observed" }));
      const enrolled = await Effect.runPromise(db.enrollment());
      expect(enrolled.unknownCreations).toBe(0);
      expect(enrolled.targets.includes(targetId)).toBe(kind === "replace");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stale subject CAS cannot release the newer subject's material protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-subject-cas-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE }); await store.initialize();
    const workflows = continuityWorkflowPrograms({ durableRoot: root, scopeId: CONT_SCOPE });
    const source = materialFixture("captured", 1);
    await Effect.runPromise(workflows.updateSubject(CONT_AGENT, 0, CONT_AGENT, 0, { lastSnapshotId: source.requestId }));
    await expect(Effect.runPromise(workflows.updateSubject(CONT_AGENT, 0, CONT_AGENT, 0, {}))).rejects.toThrow("conflict");
    await store.publish(source);
    for (let i = 2; i < 6; i++) await store.publish(materialFixture(`newer-${i}`, i));
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await store.readSnapshot(source.requestId)).reference.ref).toBe(source.requestId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
