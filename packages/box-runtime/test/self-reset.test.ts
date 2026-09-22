import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selfResetRequest,
  type SelfResetExecution,
  type SelfResetRequest,
} from "@grokbox/runtime-kernel/continuity";
import { openContinuityRecoveryStore, openSelfResetQueue } from "../src/runtime.ts";
import { CONT_AGENT, CONT_POLICY, CONT_SCOPE, materialFixture } from "./fixtures/continuity-material.ts";

const sourceRevision = "c".repeat(64);
const nextSourceRevision = "d".repeat(64);

function requestFor(ref: { ref: string; revision: string }, revision = sourceRevision): SelfResetRequest {
  return selfResetRequest({
    version: 1,
    operationId: randomUUID(),
    agentId: CONT_AGENT,
    scopeId: CONT_SCOPE,
    sourceRevision: revision,
    sourceGeneration: "turn-1",
    policyRevision: CONT_POLICY,
    reason: "checkpoint",
    materialRefs: [{ owner: "continuity.recovery", ref: ref.ref, revision: ref.revision }],
    workflowRefs: [],
    duties: [
      { id: "checkpoint", kind: "checkpoint", materialRefs: [] },
      { id: "memory", kind: "memory", materialRefs: [] },
    ],
    requestedAtMs: Date.now(),
  });
}

function current(revision = sourceRevision) {
  return { sourceRevision: revision, sourceGeneration: "turn-1", turnSettled: true as const };
}

test("self-reset admits and returns before consumption, then consumes each duty once", async () => {
  const root = await mkdtemp(join(tmpdir(), "self-reset-queue-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE });
    await store.initialize();
    const publication = materialFixture("reset-source", 1);
    const saved = await store.publish(publication);
    const queue = openSelfResetQueue({ durableRoot: root, scopeId: CONT_SCOPE });
    const request = requestFor({ ref: publication.requestId, revision: saved.reference.revision });
    const admitted = await queue.admit(request);
    expect(admitted).toMatchObject({ operationId: request.operationId, state: "queued", duties: [
      { id: "checkpoint", state: "pending" }, { id: "memory", state: "pending" },
    ] });

    let consumeCalls = 0;
    const owner = {
      current: async () => current(),
      consume: async (): Promise<SelfResetExecution> => {
        consumeCalls += 1;
        return { state: "complete", duties: [
          { id: "checkpoint", state: "complete" }, { id: "memory", state: "complete" },
        ] };
      },
    };
    expect((await queue.consume(request.operationId, owner)).state).toBe("complete");
    expect(consumeCalls).toBe(1);
    expect((await queue.consume(request.operationId, owner)).state).toBe("complete");
    expect(consumeCalls).toBe(1);
    expect((await queue.admit(request)).state).toBe("complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("self-reset blocks a late request when the source revision changed and never calls the owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "self-reset-stale-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE });
    await store.initialize();
    const publication = materialFixture("stale-source", 1);
    const saved = await store.publish(publication);
    const queue = openSelfResetQueue({ durableRoot: root, scopeId: CONT_SCOPE });
    const request = requestFor({ ref: publication.requestId, revision: saved.reference.revision }, nextSourceRevision);
    await queue.admit(request);
    let consumeCalls = 0;
    const blocked = await queue.consume(request.operationId, {
      current: async () => current(sourceRevision),
      consume: async () => {
        consumeCalls += 1;
        return { state: "complete", duties: [
          { id: "checkpoint", state: "complete" }, { id: "memory", state: "complete" },
        ] };
      },
    });
    expect(blocked).toMatchObject({ state: "blocked", reason: "source_changed" });
    expect(blocked.duties.every(duty => duty.state === "blocked")).toBe(true);
    expect(consumeCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued and effect-unknown self-resets pin referenced material in the same GC transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "self-reset-gc-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE });
    await store.initialize();
    const first = materialFixture("reset-pinned", 1);
    const saved = await store.publish(first);
    const queue = openSelfResetQueue({ durableRoot: root, scopeId: CONT_SCOPE });
    const request = requestFor({ ref: first.requestId, revision: saved.reference.revision });
    await queue.admit(request);
    for (let i = 2; i < 7; i += 1) await store.publish(materialFixture(`newer-${i}`, i));
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await store.readSnapshot(first.requestId)).reference.ref).toBe(first.requestId);

    const result = await queue.consume(request.operationId, {
      current: async () => current(),
      consume: async () => { throw new Error("owner stopped after claim"); },
    });
    expect(result.state).toBe("unknown");
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await store.readSnapshot(first.requestId)).reference.ref).toBe(first.requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
