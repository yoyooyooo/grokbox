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
