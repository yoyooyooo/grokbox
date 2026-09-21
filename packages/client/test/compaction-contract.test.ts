import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeCompactionChange, normalizeCompactionContinuation, compactionOperation, compactionOperationRef, type CompactionChange, type CompactionOperation } from "../src/client.ts";
import { parseContextManualApproval } from "@grokbox/runtime-kernel/contract";
const I = "11111111-1111-4111-8111-111111111111", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S = "c".repeat(64), R = "d".repeat(64), target = `bot:${I}:${A}`;
const input = (): CompactionChange => ({ requestId: randomUUID(), botRef: target, scopeId: S, expectedRevision: R, confirmed: true });
const receipt = (r: CompactionChange): CompactionOperation => ({ requestId: r.requestId, operationRef: compactionOperationRef(I, S, r.requestId), botRef: target, scopeId: S, expectedRevision: R,
  state: "completed", result: { outcome: "unchanged", receiptDigest: R, sourceRevisionDigest: R, revisionDigest: R, policyRevision: R, beforeTokens: 20, afterTokens: 20, summaryRequests: 0, summaryInputTokens: 0, targetMet: true, headroomMet: true, persisted: false }, failureCode: null,
  createdAtMs: Date.now(), nativeSettlement: "returned", currentRoot: "not-observed", startedTask: false, contentIncluded: false });
const reply = (data: unknown) => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data });

test("compaction declarations reject implicit consent, payloads, wrong installation and coercion before dispatch", () => {
  const r = input(); expect(normalizeCompactionChange(r, I)).toEqual(r);
  for (const patch of [{ confirmed: false }, { body: "PRIVATE" }, { sessionId: "named" }, { expectedRevision: "invalid" }, { botRef: `bot:${randomUUID()}:${A}` }]) expect(() => normalizeCompactionChange({ ...r, ...patch }, I)).toThrow();
  let calls = 0;
  expect(() => normalizeCompactionChange({ ...r, get botRef() { calls++; return target; } }, I)).toThrow();
  expect(() => normalizeCompactionContinuation({ requestId: r.requestId, botRef: target, scopeId: S, confirmed: true, action: { toString() { calls++; return "cancel"; } } }, I)).toThrow();
  expect(calls).toBe(0);
  for (const approval of [{}, { scopeId: S }, { scopeId: S, hostGeneration: R, selectionRevision: R, policyRevision: R, body: "PRIVATE" }]) expect(() => parseContextManualApproval(approval)).toThrow();
});
test("receipts distinguish unknown native effects, settled failure, no-op and admitted cancellation", () => {
  const r = input(), v = receipt(r); expect(compactionOperation(v, I, S, r.requestId)).toBe(true);
  for (const patch of [{ requestId: randomUUID() }, { scopeId: R }, { state: "unknown" }, { nativeSettlement: "not-dispatched" }, { contentIncluded: true }, { startedTask: true }, { currentRoot: "verified" }, { body: "PRIVATE" }]) expect(compactionOperation({ ...v, ...patch }, I, S, r.requestId)).toBe(false);
  for (const patch of [{ persisted: true }, { outcome: "committed", persisted: false }, { summaryRequests: -1 }, { summaryRequests: 65 }]) expect(compactionOperation({ ...v, result: { ...v.result, ...patch } }, I, S, r.requestId)).toBe(false);
  const failed = { ...v, state: "failed", result: null, failureCode: "summary_unavailable" };
  expect(compactionOperation(failed, I, S, r.requestId)).toBe(true);
  for (const failureCode of ["commit_unknown", "native_cleanup_unknown"]) expect(compactionOperation({ ...failed, failureCode }, I, S, r.requestId)).toBe(false);
  expect(compactionOperation({ ...v, state: "cancelled", result: null, nativeSettlement: "not-dispatched" }, I, S, r.requestId)).toBe(true);
});
test("lost, wrong-target and forged settled-failure replies retain the original locator without a replacement request", async () => {
  for (const fault of ["lost", "success", "failed"] as const) {
    const r = input(); let calls = 0;
    const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "synthetic-key",
      fetch: (async () => { calls++; if (fault === "lost") throw Error("lost"); const wrong = { ...receipt(r), botRef: `bot:${I}:${B}` };
        return fault === "success" ? reply(wrong) : Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: false,
          error: { code: "compaction_failed", message: "Settled", details: { operation: { ...wrong, state: "failed", result: null, failureCode: "summary_unavailable" } } } }, { status: 422 }); }) as unknown as typeof fetch });
    await expect(client.compact(r)).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: r.requestId, lookupPath: `/v1/context-compaction-operations/${S}/${r.requestId}` } }); expect(calls).toBe(1);
  }
});
test("the credential await cannot change compaction approval, target or recovery identity", async () => {
  const r = input(), original = structuredClone(r); let release!: () => void, seen: unknown;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => { await waiting; return "synthetic-key"; },
    fetch: (async (_url, init) => { seen = JSON.parse(String(init?.body)); return reply(receipt(original)); }) as typeof fetch });
  const pending = client.compact(r); r.requestId = randomUUID(); r.expectedRevision = S; r.botRef = `bot:${I}:${B}`; release(); await pending; expect(seen).toEqual(original);
});
