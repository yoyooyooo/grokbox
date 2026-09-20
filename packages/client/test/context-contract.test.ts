import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeContextChange, normalizeContextContinuation, contextOperationRef, type ContextChange, type ContextOperation } from "../src/client.ts";
import { contextView, contextOperation } from "../src/context-validation.ts";
const I = "11111111-1111-4111-8111-111111111111", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S = "c".repeat(64), R = "d".repeat(64), target = `bot:${I}:${A}`;
const input = (): ContextChange => ({ requestId: randomUUID(), botRef: target, scopeId: S, expectedRevision: R, action: "capture", confirmed: true });
const receipt = (r: ContextChange): ContextOperation => ({ requestId: r.requestId, operationRef: contextOperationRef(I, S, r.requestId), botRef: target, scopeId: S, action: "capture", expectedRevision: R,
  state: "captured", captureRef: `snapshot:${I}:${S}:${B}`, backupRef: null, candidateRef: null, application: "not-recorded", activation: "not-requested", activationExpectedRevision: null,
  createdAtMs: Date.now(), sourceBodyIncluded: false, startedTask: false, currentTargetUsability: "not-observed" });
const reply = (data: unknown) => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data });

test("context declarations reject implicit consent, mixed source actions, foreign scope and coercion getters before transport", () => {
  const r = input(); expect(normalizeContextChange(r, I)).toEqual(r);
  for (const change of [{ confirmed: false }, { action: "activate" }, { action: "initialize" }, { body: "private" }, { expectedRevision: "stale" },
    { snapshotRef: `snapshot:${I}:${S}:${A}` }, { botRef: `bot:${randomUUID()}:${A}` }, { action: "restore", snapshotRef: `snapshot:${I}:${R}:${B}` }])
    expect(() => normalizeContextChange({ ...r, ...change }, I)).toThrow();
  let calls = 0;
  expect(() => normalizeContextChange({ ...r, get botRef() { calls++; return target; } }, I)).toThrow();
  expect(() => normalizeContextChange({ ...r, action: { toString() { calls++; return "capture"; } } }, I)).toThrow();
  expect(() => normalizeContextContinuation({ requestId: r.requestId, scopeId: S, botRef: target, action: "cancel", confirmed: true, expectedRevision: R }, I)).toThrow();
  expect(calls).toBe(0);
});

test("head projection rejects private content, foreign identities and invented execution permission", () => {
  const v = { botRef: target, scopeId: S, revision: R, policyRevision: R, hostSourceSha: R, nativeSchema: "synthetic-v1", hostGeneration: "original-1",
    state: "prepared", effects: "clear", hasCheckpoint: true, observedAtMs: Date.now(), contentIncluded: false, currentOwnershipProven: false };
  expect(contextView(v, I, target)).toBe(true);
  for (const patch of [{ content: "private" }, { currentOwnershipProven: true }, { contentIncluded: true }, { botRef: `bot:${I}:${B}` }, { state: "empty" }, { effects: "assume-clear" }, { revision: "bad" }])
    expect(contextView({ ...v, ...patch }, I, target)).toBe(false);
});

test("context receipts bind the original request, source revision and separate application, activation and cancellation facts", () => {
  const r = input(), v = receipt(r); expect(contextOperation(v, I, v.operationRef, target, r)).toBe(true);
  for (const patch of [{ expectedRevision: S }, { requestId: randomUUID() }, { botRef: `bot:${I}:${B}` }, { startedTask: true }, { state: "prepared" }, { captureRef: null },
    { captureRef: `snapshot:${I}:${R}:${B}` }, { content: "private" }, { activation: "released" }, { state: "cancelled", application: "succeeded" }])
    expect(contextOperation({ ...v, ...patch }, I, v.operationRef, target, r)).toBe(false);
  const prepared = { ...v, action: "reset", captureRef: null, backupRef: `snapshot:${I}:${S}:${A}`, candidateRef: `snapshot:${I}:${S}:${B}`, application: "succeeded", state: "prepared" };
  expect(contextOperation(prepared, I, v.operationRef)).toBe(true);
  expect(contextOperation({ ...prepared, activation: "unknown", activationExpectedRevision: R, state: "unknown" }, I, v.operationRef)).toBe(true);
  expect(contextOperation({ ...prepared, activation: "unknown", activationExpectedRevision: null, state: "unknown" }, I, v.operationRef)).toBe(false);
});

test("mismatched success and interrupted replies retain the original context recovery locator without retry", async () => {
  for (const fault of ["identity", "transport"] as const) {
    const r = input(); let calls = 0;
    const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "fixture-key",
      fetch: (async () => { calls++; if (fault === "transport") throw Error("lost"); return reply({ ...receipt(r), botRef: `bot:${I}:${B}` }); }) as unknown as typeof fetch });
    await expect(client.changeContext(r)).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: r.requestId, lookupPath: `/v1/context-operations/${S}/${r.requestId}` } });
    expect(calls).toBe(1);
  }
});

test("credential waits cannot change the captured context request or its continuation identity", async () => {
  const r = input(); let release!: () => void, seen: unknown;
  const gate = new Promise<void>(done => { release = done; });
  const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => { await gate; return "fixture-key"; },
    fetch: (async (_url, init) => { seen = JSON.parse(String(init?.body)); return reply(receipt(seen as ContextChange)); }) as typeof fetch });
  const original = structuredClone(r), pending = client.changeContext(r); r.requestId = randomUUID(); r.botRef = `bot:${I}:${B}`; r.expectedRevision = S;
  release(); await pending; expect(seen).toEqual(original);
  let sends = 0; const local = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "fixture-key", fetch: (async () => { sends++; return reply({}); }) as unknown as typeof fetch });
  expect(() => local.continueContext({ requestId: original.requestId, scopeId: S, botRef: target, action: "activate", confirmed: true, expectedRevision: "bad" })).toThrow();
  expect(() => local.contextOperation(contextOperationRef(randomUUID(), S, original.requestId))).toThrow();
  expect(sends).toBe(0);
});
