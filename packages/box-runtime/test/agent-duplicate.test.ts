import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentDuplication, openContinuityRecoveryStore } from "../src/runtime.ts";
import { DuplicateDispatchRefused, duplicatePlan, type DuplicateSource, type NativeDuplicatePort } from "@grokbox/runtime-kernel/continuity";
import type { ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scopeId = "c".repeat(64);
function observed(): DuplicateSource { return { agentId: sourceId, scopeId, generation: "d".repeat(64), profileRevision: "e".repeat(64), routineRevision: "f".repeat(64),
  harness: "temporal", observedAtMs: Date.now(), returnedRoutines: 2, enabledRoutines: 1, routineCoverage: "native_returned_window" }; }
async function setup(hooks: ContinuityStoreHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "owned-duplicate-")); let dispatches = 0, inspections = 0;
  const native: NativeDuplicatePort = { inspectSource: async () => { inspections++; return observed(); },
    duplicate: async request => { dispatches++; return { version: 1, operationId: request.operationId, sourceAgentId: sourceId, targetAgentId: targetId,
      scopeId, generation: request.source.generation, receivedAtMs: Date.now(), evidence: "native_response" }; },
    inspectTarget: async result => ({ agentId: result.targetAgentId, state: "confirmed_temporal", readBack: true }) };
  const owner = openAgentDuplication({ durableRoot: root, scopeId, native }, hooks);
  const command = { sourceAgentId: sourceId, operationId: randomUUID(), expectedPlanRevision: duplicatePlan(observed()).revision, confirmed: true };
  return { root, native, owner, command, dispatches: () => dispatches, inspections: () => inspections,
    close: () => rm(root, { recursive: true, force: true }) };
}

test("preview discloses native side effects and creates no management files", async () => {
  const f = await setup();
  try {
    expect(await f.owner.preview(sourceId)).toMatchObject({ fullClone: false, routineCoverageComplete: false,
      effects: { guaranteedBox: false, routinesAutomaticallyPaused: false, maySelectNewActiveChat: true, clearsConversation: true } });
    expect(await readdir(f.root)).toEqual([]); expect(f.dispatches()).toBe(0);
    await expect(f.owner.execute({ ...f.command, confirmed: false })).rejects.toThrow("invalid_material");
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.close(); }
});

test("official duplicate records new identity before ownership readback and does not require Box output", async () => {
  const f = await setup();
  try {
    const result = await f.owner.execute(f.command);
    expect(result).toMatchObject({ operation: { state: "succeeded", kind: "duplicate" }, result: { sourceAgentId: sourceId, targetAgentId: targetId },
      nativeDispatched: true, target: { state: "confirmed_temporal", readBack: true } });
    expect(f.dispatches()).toBe(1);
    const sourceReads = f.inspections(); f.native.inspectSource = async () => { throw Error("source-deleted"); };
    const fresh = openAgentDuplication({ durableRoot: f.root, scopeId, native: f.native });
    expect(await fresh.execute(f.command)).toMatchObject({ nativeDispatched: false, targetCheckedNow: false, result: { targetAgentId: targetId } });
    expect(f.dispatches()).toBe(1); expect(f.inspections()).toBe(sourceReads);
    expect(await openAgentDuplication({ durableRoot: f.root, scopeId }).operation(f.command.operationId)).toMatchObject({ result: { targetAgentId: targetId } });
  } finally { await f.close(); }
});

test("optional target read failure does not discard an acknowledged and durable creation", async () => {
  const f = await setup();
  try {
    f.native.inspectTarget = async () => { throw Error("private-read-error"); };
    expect(await f.owner.execute(f.command)).toMatchObject({ operation: { state: "succeeded" }, target: null, targetCheckedNow: false });
    expect(await f.owner.operation(f.command.operationId)).toMatchObject({ result: { targetAgentId: targetId } });
    expect(f.dispatches()).toBe(1);
  } finally { await f.close(); }
});

test("lost native response remains unknown and a new operation ID cannot bypass the source guard", async () => {
  const f = await setup(); let calls = 0;
  try {
    f.native.duplicate = async () => { calls++; throw Error("SECRET_RESPONSE_LOST"); };
    await expect(f.owner.execute(f.command)).rejects.toThrow("commit_unknown");
    expect(await f.owner.execute(f.command)).toMatchObject({ operation: { state: "effect_unknown" }, nativeDispatched: false, result: null });
    await expect(f.owner.execute({ ...f.command, operationId: randomUUID() })).rejects.toThrow("busy");
    expect(calls).toBe(1);
    expect(JSON.stringify(await f.owner.operation(f.command.operationId))).not.toContain("SECRET");
  } finally { await f.close(); }
});

test("response cannot claim the source identity or another operation", async () => {
  for (const mutation of [{ targetAgentId: sourceId }, { operationId: randomUUID() }, { scopeId: "0".repeat(64) }]) {
    const f = await setup(); const actual = f.native.duplicate;
    try {
      f.native.duplicate = async (request, current) => ({ ...await actual(request, current), ...mutation });
      await expect(f.owner.execute(f.command)).rejects.toThrow("commit_unknown");
      expect(await f.owner.operation(f.command.operationId)).toMatchObject({ operation: { state: "effect_unknown" }, result: null });
    } finally { await f.close(); }
  }
});

test("same source/operation contenders dispatch only once", async () => {
  const f = await setup();
  try {
    await openContinuityRecoveryStore({ durableRoot: f.root, scopeId }).initialize();
    const other = openAgentDuplication({ durableRoot: f.root, scopeId, native: f.native });
    const results = await Promise.all([f.owner.execute(f.command), other.execute(f.command)]);
    expect(results.filter(r => r.nativeDispatched)).toHaveLength(1); expect(f.dispatches()).toBe(1);
    expect(await f.owner.operation(f.command.operationId)).toMatchObject({ operation: { state: "succeeded" }, result: { targetAgentId: targetId } });
  } finally { await f.close(); }
});

test("source changed after intention was saved cannot create; a new reviewed plan can subsequently proceed", async () => {
  const f = await setup(); let reads = 0;
  try {
    f.native.inspectSource = async () => ({ ...observed(), profileRevision: ++reads === 1 ? "e".repeat(64) : "a".repeat(64) });
    await expect(f.owner.execute(f.command)).rejects.toThrow("conflict");
    expect(await f.owner.operation(f.command.operationId)).toMatchObject({ operation: { state: "not_executed" }, result: null });
    expect(f.dispatches()).toBe(0);
    const plan = await f.owner.preview(sourceId);
    expect(await f.owner.execute({ ...f.command, expectedPlanRevision: plan.revision, operationId: randomUUID() })).toMatchObject({ nativeDispatched: true });
  } finally { await f.close(); }
});

test("expired source evidence never gains extra life from a durable claim", async () => {
  const f = await setup();
  try {
    f.native.inspectSource = async () => ({ ...observed(), observedAtMs: Date.now() - 6000 });
    expect(await f.owner.execute(f.command)).toMatchObject({ operation: { state: "not_executed" }, nativeDispatched: false });
    expect(f.dispatches()).toBe(0);
  } finally { await f.close(); }
});

test("lost local result-commit acknowledgment is reconciled by the same operation, never a second native copy", async () => {
  let armed = true;
  const f = await setup({ afterCommit: async label => { if (label === "record-duplication" && armed) { armed = false; throw Error("owned-after-commit"); } } });
  try {
    await expect(f.owner.execute(f.command)).rejects.toThrow("commit_unknown");
    expect(await f.owner.execute(f.command)).toMatchObject({ nativeDispatched: false, operation: { state: "succeeded" }, result: { targetAgentId: targetId } });
    expect(f.dispatches()).toBe(1);
  } finally { await f.close(); }
});

test("failed result persistence preserves the acknowledged target in a bounded unknown error", async () => {
  const f = await setup({ beforeCommit: async label => { if (label === "record-duplication") throw Error("owned-no-result-commit"); } });
  try {
    await expect(f.owner.execute(f.command)).rejects.toMatchObject({ code: "commit_unknown", created: { targetAgentId: targetId, evidence: "native_response" } });
    expect(await f.owner.operation(f.command.operationId)).toMatchObject({ operation: { state: "effect_unknown" }, result: null });
    expect(await f.owner.execute(f.command)).toMatchObject({ nativeDispatched: false });
    expect(f.dispatches()).toBe(1);
  } finally { await f.close(); }
});

test("an explicit local pre-fetch refusal can prove no dispatch, unlike any HTTP response failure", async () => {
  const f = await setup();
  try {
    f.native.duplicate = async () => { throw new DuplicateDispatchRefused("generation_changed"); };
    expect(await f.owner.execute(f.command)).toMatchObject({ operation: { state: "not_executed" }, nativeDispatched: false });
    expect(f.dispatches()).toBe(0);
  } finally { await f.close(); }
});

test("cancellation during native creation joins its bounded outcome before exposing interruption", async () => {
  const f = await setup(); const abort = new AbortController();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const original = f.native.duplicate;
  try {
    f.native.duplicate = async (request, current) => { entered(); await finish; return original(request, current); };
    const pending = f.owner.execute(f.command, abort.signal); void pending.catch(() => undefined);
    await started; abort.abort(); release();
    await pending.catch(() => undefined);
    const saved = await f.owner.operation(f.command.operationId);
    expect(saved).toMatchObject({ operation: { state: "succeeded" }, result: { targetAgentId: targetId } });
    expect(await f.owner.execute(f.command)).toMatchObject({ nativeDispatched: false });
    expect(f.dispatches()).toBe(1);
  } finally { release?.(); await f.close(); }
});

test("public effect preparation cannot bypass duplicate's per-source guard", async () => {
  const f = await setup();
  try {
    const store = openContinuityRecoveryStore({ durableRoot: f.root, scopeId }); await store.initialize();
    await expect(store.prepareEffect({ kind: "duplicate", operationId: f.command.operationId, agentId: sourceId,
      inputDigest: "a".repeat(64), policyRevision: "b".repeat(64), snapshotId: null })).rejects.toThrow("conflict");
  } finally { await f.close(); }
});
