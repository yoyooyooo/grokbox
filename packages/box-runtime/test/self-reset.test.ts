import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selfResetRequest, selfResetExecution, selfResetDigest, botWorkflowRequest, botWorkflowDigest,
  type SelfResetExecution,
  type SelfResetCurrent,
  type SelfResetRequest,
} from "@grokbox/runtime-kernel/continuity";
import { openContinuityRecoveryStore, openSelfResetQueue } from "../src/runtime.ts";
import { continuityWorkflowPrograms } from "../src/internal/io/continuity-workflows.node.ts";
import type { ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";
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

const withSource = async <A>(_request: SelfResetRequest, work: (current: SelfResetCurrent) => Promise<A>): Promise<A> => work(current());

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
      withSource,
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
      withSource,
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
      withSource,
      consume: async () => { throw new Error("owner stopped after claim"); },
    });
    expect(result.state).toBe("unknown");
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await store.readSnapshot(first.requestId)).reference.ref).toBe(first.requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(hooks: ContinuityStoreHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "self-reset-edge-"));
  const input = { durableRoot: root, scopeId: CONT_SCOPE };
  const store = openContinuityRecoveryStore(input);
  await store.initialize();
  const material = materialFixture("original", 1);
  const saved = await store.publish(material);
  const request = requestFor(saved.reference);
  return { input, store, request, queue: openSelfResetQueue(input, hooks),
    programs: continuityWorkflowPrograms(input),
    close: () => rm(root, { recursive: true, force: true }) };
}
const completed = (request: SelfResetRequest): SelfResetExecution => ({
  state: "complete", duties: request.duties.map(duty => ({ id: duty.id, state: "complete" })),
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("contract rejects duplicate duty identities, forged refs and control characters while accepting self-reset reasons", async () => {
  const f = await fixture();
  try {
    expect(selfResetRequest({ ...f.request, reason: "self-reset" }).reason).toBe("self-reset");
    expect(() => selfResetRequest({ ...f.request, reason: "late\nrequest" })).toThrow("invalid_material");
    expect(() => selfResetRequest({ ...f.request, duties: [
      f.request.duties[0], { ...f.request.duties[1], id: f.request.duties[0]!.id },
    ] })).toThrow("conflict");
    expect(() => selfResetExecution({ state: "blocked", duties: [
      { id: "checkpoint", state: "complete" }, { id: "checkpoint", state: "blocked" },
    ] }, f.request)).toThrow("conflict");
    expect(() => selfResetRequest({ ...f.request,
      materialRefs: [{ ...f.request.materialRefs[0], revision: "not-a-revision" }],
    })).toThrow("invalid_material");
    const manyRefs = Array.from({ length: 64 }, () => ({ ...f.request.materialRefs[0]!, ref: randomUUID() }));
    expect(() => selfResetRequest({ ...f.request, duties: [
      { id: "checkpoint", kind: "checkpoint", materialRefs: manyRefs },
    ] })).toThrow("capacity");
  } finally { await f.close(); }
});

test("admission binds immutable original request and rejects conflicting retry, missing refs and wrong workflow digest", async () => {
  const f = await fixture();
  try {
    await expect(f.queue.admit({ ...f.request, materialRefs: [
      { ...f.request.materialRefs[0]!, revision: "f".repeat(64) },
    ] })).rejects.toThrow("conflict");
    await expect(f.queue.admit({ ...f.request, workflowRefs: [
      { operationId: randomUUID(), digest: "f".repeat(64) },
    ] })).rejects.toThrow("conflict");
    const admitted = f.queue.admit(f.request);
    const original = selfResetRequest(f.request);
    f.request.reason = "changed-before-acquisition";
    await admitted;
    expect(await f.queue.request(original.operationId)).toEqual(original);
    await expect(f.queue.admit(f.request)).rejects.toThrow("conflict");
    await expect(Effect.runPromise(f.programs.transitionControl(original.operationId, "queued", "complete", null))).rejects.toThrow("conflict");
  } finally { await f.close(); }
});

test("unsettled turn returns queued immediately; native source gate covers claim and consumption", async () => {
  const f = await fixture();
  try {
    await f.queue.admit(f.request);
    let calls = 0, held = false;
    const consume = async (request: SelfResetRequest) => {
      expect(held).toBe(true); calls += 1; return completed(request);
    };
    const deferred = await f.queue.consume(f.request.operationId, {
      withSource: async (_request, work) => work({ ...current(), turnSettled: false }), consume,
    });
    expect(deferred.state).toBe("queued"); expect(calls).toBe(0);
    const receipt = await f.queue.consume(f.request.operationId, {
      withSource: async (_request, work) => {
        held = true;
        try { return await work(current()); } finally { held = false; }
      }, consume,
    });
    expect(receipt.state).toBe("complete"); expect(calls).toBe(1); expect(held).toBe(false);
  } finally { await f.close(); }
});

test("generation drift blocks even when the source revision is unchanged", async () => {
  const f = await fixture();
  try {
    await f.queue.admit(f.request);
    const receipt = await f.queue.consume(f.request.operationId, {
      withSource: async (_request, work) => work({ ...current(), sourceGeneration: "turn-2" }),
      consume: async () => { throw new Error("must not dispatch"); },
    });
    expect(receipt).toMatchObject({ state: "blocked", reason: "source_changed" });
  } finally { await f.close(); }
});

test("concurrent consumers and cancellation after dispatch never replay or discard a settled owner result", async () => {
  const f = await fixture(), entered = barrier(), release = barrier();
  try {
    await f.queue.admit(f.request);
    const abort = new AbortController();
    let calls = 0;
    const owner = { withSource, consume: async (request: SelfResetRequest) => {
      calls += 1; entered.release(); await release.promise; return completed(request);
    } };
    const first = f.queue.consume(f.request.operationId, owner, abort.signal);
    await entered.promise;
    expect((await f.queue.consume(f.request.operationId, owner)).state).toBe("effect_unknown");
    abort.abort(); release.release();
    expect((await first).state).toBe("complete"); expect(calls).toBe(1);
    expect((await openSelfResetQueue(f.input).inspect(f.request.operationId)).state).toBe("complete");
  } finally { release.release(); await f.close(); }
});

test("lost claim acknowledgement survives reopen and requires original-digest reconciliation without redispatch", async () => {
  const f = await fixture({ afterCommit: async label => {
    if (label === "self-reset-claim") throw new Error("lost-ack");
  } });
  try {
    await f.queue.admit(f.request);
    let calls = 0;
    const owner = { withSource, consume: async (request: SelfResetRequest) => { calls += 1; return completed(request); } };
    await expect(f.queue.consume(f.request.operationId, owner)).rejects.toThrow("commit_unknown");
    const reopened = openSelfResetQueue(f.input);
    expect((await reopened.consume(f.request.operationId, owner)).state).toBe("effect_unknown");
    expect(calls).toBe(0);
    expect(await reopened.request(f.request.operationId)).toEqual(f.request);
    await expect(reopened.reconcile(f.request.operationId, "f".repeat(64), completed(f.request))).rejects.toThrow("conflict");
    expect((await reopened.reconcile(f.request.operationId, selfResetDigest(f.request), completed(f.request))).state).toBe("complete");
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test("workflow and duty refs remain pinned after workflow retirement; completion releases only self-reset protection", async () => {
  const f = await fixture();
  try {
    const second = await f.store.publish(materialFixture("duty-material", 2));
    const workflow = botWorkflowRequest({ version: 1, kind: "clone", operationId: randomUUID(), scopeId: CONT_SCOPE,
      sourceId: CONT_AGENT, profile: { name: "fixture" }, modelRef: null, instructions: "",
      snapshotId: f.request.materialRefs[0]!.ref, activate: false, start: false, maxRunMs: 1000, policyRevision: CONT_POLICY });
    await Effect.runPromise(f.programs.create(workflow));
    const request = selfResetRequest({ ...f.request, materialRefs: [],
      workflowRefs: [{ operationId: workflow.operationId, digest: botWorkflowDigest(workflow) }],
      duties: [{ id: "checkpoint", kind: "checkpoint", materialRefs: [second.reference] }],
    });
    await f.queue.admit(request);
    await Effect.runPromise(f.programs.phase(workflow.operationId, "retired"));
    for (let i = 3; i < 8; i++) await f.store.publish(materialFixture("newer-" + i, i));
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(workflow.snapshotId!)).reference.ref).toBe(workflow.snapshotId!);
    expect((await f.store.readSnapshot(second.reference.ref)).reference.ref).toBe(second.reference.ref);
    await f.queue.consume(request.operationId, { withSource, consume: async request => completed(request) });
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    await expect(f.store.readSnapshot(workflow.snapshotId!)).rejects.toThrow();
    await expect(f.store.readSnapshot(second.reference.ref)).rejects.toThrow();
  } finally { await f.close(); }
});

test("unknown duty outcomes retain produced material, reject forged outcomes and never erase completed duties during reconciliation", async () => {
  const f = await fixture();
  try {
    const output = await f.store.publish(materialFixture("memory-output", 2));
    await f.queue.admit(f.request);
    const partial: SelfResetExecution = { state: "unknown", duties: [
      { id: "checkpoint", state: "complete", materialRefs: [output.reference] },
      { id: "memory", state: "unknown", reason: "late-result" },
    ] };
    expect((await f.queue.consume(f.request.operationId, { withSource, consume: async () => partial })).state).toBe("unknown");
    for (let i = 3; i < 8; i++) await f.store.publish(materialFixture("newer-" + i, i));
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(output.reference.ref)).reference.ref).toBe(output.reference.ref);
    await expect(f.queue.reconcile(f.request.operationId, selfResetDigest(f.request), completed(f.request))).rejects.toThrow("conflict");
    const finish: SelfResetExecution = { state: "complete", duties: [partial.duties[0]!, { id: "memory", state: "complete" }] };
    expect((await f.queue.reconcile(f.request.operationId, selfResetDigest(f.request), finish)).state).toBe("complete");
  } finally { await f.close(); }
});
