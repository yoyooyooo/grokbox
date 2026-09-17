import { expect, test } from "bun:test";
import { captureContextPolicy, contextBudget, summaryBudget } from "@grokbox/runtime-kernel/config";
import { ContextFailure, type ContextCandidate } from "@grokbox/runtime-kernel/contract";
import { validateContextReplacement } from "@grokbox/runtime-kernel/inference";
import { createNativeContextOwner } from "../src/internal/host/context-maintenance.ts";
import { planPiCompaction } from "../src/internal/context/pi-projection.ts";
import { ownedNativeSummary } from "./context-native-fixture.ts";

function fixture(options: { checkpointFails?: boolean; appendFails?: boolean; beforeAccept?: () => Promise<void>; checkpointWait?: () => Promise<void> } = {}) {
  let live = true, checkpoints = 0;
  let messages: any[] = [
    { role: "system", content: "Retain system policy", providerOptions: { privateControl: { sentinel: "SYSTEM" } } },
    { role: "user", content: "Fixed user info", providerOptions: { privateControl: { sentinel: "USER_INFO" } } },
    { role: "user", content: "earlier request " + "history ".repeat(10000) },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call\n1", toolName: "read", args: { file: "owned" } }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call\n1", toolName: "read", result: "x".repeat(24000) + "TOOL_TAIL=present" }] },
    { role: "assistant", content: "failed", providerOptions: { error: "old-failure" } },
    { role: "user", content: "NEW_NONCE=one", providerOptions: { futureMetadata: { order: 1 } } },
  ];
  const original = structuredClone(messages), native = ownedNativeSummary({ beforeAccept: options.beforeAccept });
  native.state.lastStepInvocationId = "step";
  const controller = new AbortController();
  let clears = 0, appends = 0;
  const root = { getMessages: () => structuredClone(messages), clearMessages: () => { clears++; messages = []; }, appendMessages: (next: any[]) => {
    appends++; if (options.appendFails) throw Error("PRIVATE_PARTIAL_NATIVE_WRITE"); messages.push(...next);
  } };
  const owner = createNativeContextOwner({ ...native, stateHandler: native.state, rootPromptExecutor: root,
    ctx: { signal: controller.signal }, config: {}, interactionListener: {}, requestContext: {}, resourceAccessor: {},
    invocationId: "step", turnId: "turn", agentId: "agent", sessionId: "", modelId: "owned/model",
    normalize: rows => rows, fixedMessages: () => root.getMessages().slice(0, 2), tools: () => [], valid: () => live,
    checkpoint: async () => { await options.checkpointWait?.(); if (options.checkpointFails) throw new Error("checkpoint_failed"); checkpoints++; },
  });
  const material = owner.inspect();
  const policy = captureContextPolicy({ windowTokens: 32000, compaction: { reserveTokens: 4096, keepRecentTokens: 500 } }, "owned/model", "agent");
  const budget = contextBudget(policy, 500000), sb = summaryBudget(policy, 500000);
  const plan = planPiCompaction(material, budget, sb.inputTokens);
  const candidate: ContextCandidate = { operationId: "owned-operation", sourceRootRevision: material.rootRevision,
    summary: "Earlier work completed. TOOL_TAIL=present", summarizedRefs: plan.summarizedRefs, retainedRefs: plan.retainedRefs, budget };
  return { owner, native, original, material, candidate, root, controller,
    current: () => messages, checkpoints: () => checkpoints, writes: () => ({ clears, appends }), revoke: () => { live = false; } };
}

test("native fixed material survives cloning reads; preview does not mutate or checkpoint", async () => {
  const f = fixture();
  try {
    expect(f.material.messages.slice(0, 2).every(row => row.preserve)).toBe(true);
    const next = await f.owner.preview(f.candidate);
    expect(f.current()).toEqual(f.original);
    expect(f.checkpoints()).toBe(0);
    expect(validateContextReplacement(f.material, f.candidate, next)).toEqual(next);
    const commit = await f.owner.commit(f.candidate);
    expect(commit).toMatchObject({ outcome: "committed", persisted: true });
    expect(f.current().slice(0, 2)).toEqual(f.original.slice(0, 2));
    expect(f.current().at(-1)).toEqual(f.original.at(-1));
    expect(f.checkpoints()).toBe(1);
    expect(f.owner.readCommit()?.rootRevision).toBe(commit.rootRevision);
    expect(f.native.state.archive).toHaveLength(1);
  } finally { await f.owner.close(); }
});

test("cancel between preview and accept keeps old root and settles the native source", async () => {
  const f = fixture();
  await f.owner.preview(f.candidate);
  f.owner.cancel();
  await expect(f.owner.commit(f.candidate)).rejects.toMatchObject({ code: "cancelled" });
  await f.owner.close();
  expect(f.current()).toEqual(f.original);
  expect(f.checkpoints()).toBe(0);
  expect(f.native.state.backgroundSummarizationPromiseInfo).toBeNull();
});

test("root changed after preview refuses rather than merging an unverified tail", async () => {
  const f = fixture();
  try {
    await f.owner.preview(f.candidate);
    f.root.appendMessages([{ role: "user", content: "later owner input" }]);
    await expect(f.owner.commit(f.candidate)).rejects.toMatchObject({ code: "stale_root" });
    expect(f.current()).toEqual([...f.original, { role: "user", content: "later owner input" }]);
    expect(f.checkpoints()).toBe(0);
  } finally { await f.owner.close(); }
});

test("lost checkpoint ack is not described as a rollback of the published root", async () => {
  const f = fixture({ checkpointFails: true });
  try {
    await f.owner.preview(f.candidate);
    await expect(f.owner.commit(f.candidate)).rejects.toMatchObject({ code: "commit_unknown" });
    expect(f.current()).not.toEqual(f.original);
    expect(f.owner.readCommit()).toMatchObject({ outcome: "commit_unknown", persisted: false });
    expect(f.checkpoints()).toBe(0);
  } finally { await f.owner.close(); }
});

test("owner cleanup waits for the real checkpoint after cancellation, rather than only waiting for summary generation", async () => {
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ checkpointWait: async () => { enter(); await held; } });
  let closing: Promise<void> | undefined;
  try {
    await f.owner.preview(f.candidate);
    const committing = f.owner.commit(f.candidate).then(value => value, error => error);
    await started;
    expect(f.owner.hasPublicationStarted()).toBe(true);
    f.owner.cancel();
    let settled = false;
    closing = f.owner.close().then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(f.checkpoints()).toBe(0);
    release();
    expect(await committing).toMatchObject({ code: "commit_unknown" });
    await closing;
    expect(settled).toBe(true);
    expect(f.checkpoints()).toBe(1);
    expect(f.current()).not.toEqual(f.original);
  } finally { release(); await closing; await f.owner.close(); }
});

test("partial native replacement is commit_unknown even if append never returns; no fake rollback or second write", async () => {
  const f = fixture({ appendFails: true });
  try {
    await f.owner.preview(f.candidate);
    const error = await f.owner.commit(f.candidate).then(() => undefined, error => error);
    expect(error).toMatchObject({ code: "commit_unknown" });
    expect(String(error)).not.toContain("PRIVATE_PARTIAL_NATIVE_WRITE");
    expect(f.current()).toEqual([]); // The original native clear really occurred.
    expect(f.writes()).toEqual({ clears: 1, appends: 1 });
    expect(f.owner.readCommit()).toBeUndefined();
    expect(await f.owner.commit(f.candidate)).toMatchObject({ outcome: "commit_unknown", persisted: false });
    expect(f.writes()).toEqual({ clears: 1, appends: 1 });
    expect(f.checkpoints()).toBe(0);
  } finally { await f.owner.close(); }
});

test("existing pending source is cancelled through its owner and awaited, never erased while pending", async () => {
  const f = fixture();
  let cancelCalled = 0, settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  const pending = { promise, startInvocationId: "older-step" };
  f.native.state.backgroundSummarizationPromiseInfo = pending;
  f.native.state.backgroundSummarizationCancellationToken = { cancelled: false, onCancelled() { cancelCalled++; settle(); } };
  try {
    await f.owner.preview(f.candidate);
    expect(cancelCalled).toBe(1);
    expect(f.native.state.backgroundSummarizationPromiseInfo).not.toBe(pending);
    await f.owner.commit(f.candidate);
    expect(f.checkpoints()).toBe(1);
  } finally { await f.owner.close(); }
});

test("self-dependent native summary is a finite refusal, not a deadlock or forgotten Promise", async () => {
  const f = fixture();
  const pending = { promise: Promise.resolve(), startInvocationId: "step" };
  f.native.state.backgroundSummarizationPromiseInfo = pending;
  try {
    await expect(f.owner.preview(f.candidate)).rejects.toMatchObject({ code: "maintenance_busy" });
    expect(f.native.state.backgroundSummarizationPromiseInfo).toBe(pending);
    expect(f.current()).toEqual(f.original);
  } finally { await f.owner.close(); }
});

test("independent candidate validator refuses partial tool groups, missing protected rows and fake summaries", async () => {
  const f = fixture();
  try {
    const next = await f.owner.preview(f.candidate);
    for (const broken of [
      { ...f.candidate, retainedRefs: f.candidate.retainedRefs.slice(1) },
      { ...f.candidate, summary: "not present in native carrier" },
      { ...f.candidate, summarizedRefs: [...f.candidate.summarizedRefs, f.candidate.summarizedRefs[0]!] },
    ]) expect(() => validateContextReplacement(f.material, broken, next)).toThrow(ContextFailure);
    const changed = structuredClone(next); changed.messages.at(-1)!.message.content = "discarded input";
    expect(() => validateContextReplacement(f.material, f.candidate, changed)).toThrow(ContextFailure);
  } finally { await f.owner.close(); }
});
