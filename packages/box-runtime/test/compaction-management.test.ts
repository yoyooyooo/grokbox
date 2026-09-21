import { expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextManualApprovalRevision, type ContextMaintenanceReceipt } from "@grokbox/runtime-kernel/contract";
import { captureContextPolicy, contextBudget } from "@grokbox/runtime-kernel/config";
import { compactionManagementPrograms, compactionControlId, type ManagedCompactionDeclaration } from "../src/internal/io/compaction-management.node.ts";
import { contextManagementPrograms, managedContextRecord } from "../src/internal/io/context-management.node.ts";
import { type ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";
const install = "11111111-1111-4111-8111-111111111111", agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId = "a".repeat(64);
const policy = captureContextPolicy(undefined, "owned/model", agentId), budget = contextBudget(policy, 500000);
const run = Effect.runPromise;
function declaration(): ManagedCompactionDeclaration {
  const approval = { scopeId, hostGeneration: "b".repeat(64), selectionRevision: "c".repeat(64), policyRevision: policy.revision };
  return { installationId: install, principalId: "owner", requestId: randomUUID(), agentId, scopeId, approval, expectedRevision: contextManualApprovalRevision(agentId, approval) };
}
function receipt(operationId: string): ContextMaintenanceReceipt {
  const measure = (tokens: number) => ({ method: "estimate" as const, meterVersion: "owned", tokens, estimatedTokens: tokens, uncertaintyTokens: 0, bytes: tokens * 2, messageCount: 2, components: { system: 5, messages: tokens - 5, tools: 0 } });
  return { operationId, rootId: "owned-root", sourceRootRevision: "before", rootRevision: "after", outcome: "committed", policyRevision: policy.revision, budget,
    before: measure(100), after: measure(50), summaryRequests: 1, summaryInputTokens: 100, targetMet: true, headroomMet: true, persisted: true };
}
async function fixture(hooks: ContinuityStoreHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "compaction-owner-")), owner = compactionManagementPrograms(root, scopeId, hooks);
  await run(owner.initialize()); return { root, owner, hooks, close: () => rm(root, { recursive: true, force: true }) };
}

test("the original CONT table serializes competing drivers and never grants a second dispatch", async () => {
  const f = await fixture();
  try {
    const q = declaration(), r = await run(f.owner.reserve(q)), second = compactionManagementPrograms(f.root, scopeId);
    const claims = await Promise.all([run(f.owner.claim(r.operationId)), run(second.claim(r.operationId))]);
    expect(claims.filter(c => c.dispatch)).toHaveLength(1);
    await expect(run(f.owner.cancel(r.operationId))).rejects.toThrow("conflict");
    await expect(run(second.reserve({ ...q, requestId: randomUUID(), principalId: "other" }))).rejects.toThrow("conflict");
    expect((await run(second.read(r.operationId)))!.state).toBe("effect_unknown");
    const done = await run(second.settle(r.operationId, receipt(r.operationId)));
    expect(done.state).toBe("complete"); expect((await run(f.owner.reserve(q))).result).toEqual(done.result);
    expect((await run(f.owner.claim(r.operationId))).dispatch).toBe(false);
    await expect(run(f.owner.reserve({ ...q, expectedRevision: "f".repeat(64) }))).rejects.toThrow();
    const bytes = await readFile(join(f.root, "continuity", "state.sqlite")); await run(second.read(r.operationId));
    expect(await readFile(join(f.root, "continuity", "state.sqlite"))).toEqual(bytes);
  } finally { await f.close(); }
});

test("safe preparation cancellation and a settled native failure remain terminal without replaying old input", async () => {
  const f = await fixture();
  try {
    const cancelled = await run(f.owner.reserve(declaration())); await run(f.owner.cancel(cancelled.operationId));
    expect((await run(f.owner.reserve(cancelled.declaration))).cancelled).toBe(true);
    expect((await run(f.owner.claim(cancelled.operationId))).dispatch).toBe(false);
    const failed = await run(f.owner.reserve(declaration())); await run(f.owner.claim(failed.operationId));
    for (const code of ["commit_unknown", "native_cleanup_unknown", "arbitrary"]) await expect(run(f.owner.fail(failed.operationId, code))).rejects.toThrow("conflict");
    expect((await run(f.owner.fail(failed.operationId, "summary_unavailable"))).failureCode).toBe("summary_unavailable");
    await expect(run(f.owner.settle(failed.operationId, receipt(failed.operationId)))).rejects.toThrow("conflict");
    expect((await run(f.owner.reserve(declaration()))).state).toBe("prepared");
  } finally { await f.close(); }
});

for (const phase of ["managed-compaction-prepare", "managed-compaction-claim", "managed-compaction-settle"] as const) test(`lost ${phase} acknowledgement preserves exact committed history`, async () => {
  const f = await fixture();
  try {
    const q = declaration(), id = compactionControlId(install, q.principalId, q.requestId);
    if (phase !== "managed-compaction-prepare") await run(f.owner.reserve(q));
    if (phase === "managed-compaction-settle") await run(f.owner.claim(id));
    let once = true; f.hooks.afterCommit = async name => { if (name === phase && once) { once = false; throw Error("lost-ack"); } };
    await expect(phase === "managed-compaction-prepare" ? run(f.owner.reserve(q)) : phase === "managed-compaction-claim" ? run(f.owner.claim(id)) : run(f.owner.settle(id, receipt(id)))).rejects.toThrow("commit_unknown");
    const reopened = compactionManagementPrograms(f.root, scopeId), original = await run(reopened.read(id));
    expect(original!.state).toBe(phase === "managed-compaction-prepare" ? "prepared" : phase === "managed-compaction-claim" ? "effect_unknown" : "complete");
    if (phase !== "managed-compaction-prepare") expect((await run(reopened.claim(id))).dispatch).toBe(false);
  } finally { await f.close(); }
});

test("capacity never retires unresolved dispatch or turns existing history into new admission", async () => {
  const f = await fixture();
  try {
    const q = declaration(), unknown = await run(f.owner.reserve(q)); await run(f.owner.claim(unknown.operationId));
    for (let i = 1; i < 512; i++) {
      const d = declaration(); d.agentId = randomUUID(); d.expectedRevision = contextManualApprovalRevision(d.agentId, d.approval);
      const r = await run(f.owner.reserve(d)); await run(f.owner.cancel(r.operationId));
    }
    const more = declaration(); more.agentId = randomUUID(); more.expectedRevision = contextManualApprovalRevision(more.agentId, more.approval);
    await expect(run(f.owner.reserve(more))).rejects.toThrow("capacity");
    expect((await run(f.owner.reserve(q))).state).toBe("effect_unknown");
    expect((await run(f.owner.claim(unknown.operationId))).dispatch).toBe(false);
  } finally { await f.close(); }
}, 30000);

test("reserved current-state and compaction cannot silently coexist on one Bot", async () => {
  const f = await fixture();
  try {
    const nativeHead = { agentId, scopeId, hostSourceSha: "b".repeat(64), nativeSchema: "owned-schema", hostGeneration: "owned", contextRevision: "c".repeat(64), activationEpoch: "owned", rootHash: null, state: "empty", effects: "clear" };
    const ordinary = contextManagementPrograms(f.root, scopeId);
    const q = { installationId: install, principalId: "owner", requestId: randomUUID(), agentId, scopeId, expectedRevision: "c".repeat(64), action: "reset" as const, snapshotId: null };
    const prior = await run(ordinary.reserve(managedContextRecord(q, nativeHead as never, "d".repeat(64))));
    await expect(run(f.owner.reserve(declaration()))).rejects.toThrow("conflict");
    await run(ordinary.cancel(prior.record.operationId));
    const c = await run(f.owner.reserve(declaration())); await run(f.owner.claim(c.operationId));
    await expect(run(ordinary.reserve(managedContextRecord({ ...q, requestId: randomUUID() }, nativeHead as never, "d".repeat(64))))).rejects.toThrow("conflict");
  } finally { await f.close(); }
});
