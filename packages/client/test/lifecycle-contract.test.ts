import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeLifecycleIntent, normalizeLifecycleSubmission, lifecycleReference, type LifecycleIntent, type LifecycleOperation } from "../src/client.ts";
import { lifecycleOperation, lifecycleList, lifecyclePreview } from "../src/lifecycle-validation.ts";
const I = "11111111-1111-4111-8111-111111111111", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scope = "e".repeat(64), plan = "b".repeat(64);
const intent = (): LifecycleIntent => normalizeLifecycleIntent({ requestId: randomUUID(), kind: "clone", sourceBotRef: A, name: "Clone", instructions: "PRIVATE_BODY" }, I);
const receipt = (r: LifecycleIntent): LifecycleOperation => ({ requestId: r.requestId, operationRef: lifecycleReference(I, scope, r.requestId), scopeId: scope, planRevision: plan,
  kind: r.kind, sourceBotRef: r.sourceBotRef, targetBotRef: `bot:${I}:${B}`, state: "ready", steps: (["capture", "create", "load", "model", "compose", "initialize"] as const).map(step => ({ step, state: "complete" as const })), effectsUnknown: false,
  createdAtMs: 1, updatedAtMs: 2, requestedActivation: r.activate, requestedStartup: r.start, handoverRef: null,
  currentTargetUsability: "not-observed", sourceRetirement: "not-observed", privateInputsIncluded: false });
const envelope = (data: unknown) => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data });

test("lifecycle declarations validate exact identity, bounded input and independent startup/message intent", () => {
  const r = intent(); expect(normalizeLifecycleIntent(r, I)).toEqual(r);
  for (const patch of [{ kind: "delete" }, { sourceBotRef: "name" }, { sourceBotRef: `bot:${randomUUID()}:${A}` }, { requestId: "opaque" }, { instructions: "x".repeat(32769) },
    { modelId: "raw key value" }, { start: true, activate: false }, { allowHandoverMessages: true }, { nativeCommand: "sendPrompt" }, { url: "https://private.invalid" }, { maxRunMs: 0 }]) expect(() => normalizeLifecycleIntent({ ...r, ...patch }, I)).toThrow();
  expect(normalizeLifecycleIntent({ requestId: randomUUID(), kind: "spawn", name: "New" }, I)).toMatchObject({ sourceBotRef: null, activate: true, start: true });
  let calls = 0; expect(() => normalizeLifecycleIntent({ ...r, get instructions() { calls++; return "private"; } }, I)).toThrow(); expect(calls).toBe(0);
  expect(() => normalizeLifecycleIntent({ ...r, kind: { toString() { calls++; return "clone"; } } }, I)).toThrow(); expect(calls).toBe(0);
  expect(() => normalizeLifecycleSubmission({ ...r, scopeId: scope, planRevision: plan, confirmed: false }, I)).toThrow();
});

test("lifecycle wire views reject foreign targets, private data and invented completion or retirement proof", () => {
  const r = intent(), good = receipt(r); expect(lifecycleOperation(good, I, good.operationRef, plan, r)).toBe(true);
  for (const patch of [{ operationRef: lifecycleReference(randomUUID(), scope, r.requestId) }, { targetBotRef: r.sourceBotRef }, { sourceBotRef: null }, { instructions: "PRIVATE" },
    { currentTargetUsability: "verified" }, { sourceRetirement: "safe" }, { privateInputsIncluded: true }, { planRevision: "c".repeat(64) }, { effectsUnknown: true },
    { steps: [{ step: "create", state: "complete", result: { token: "PRIVATE" } }] }, { steps: [good.steps[0], good.steps[0]] }, { state: "active" }, { steps: [{ step: "create", state: "complete" }] }]) expect(lifecycleOperation({ ...good, ...patch }, I, good.operationRef, plan, r)).toBe(false);
  const page = { operations: [good], scopeId: scope, nextCursor: null, coverage: "retained-principal-workflows" };
  expect(lifecycleList(page, I, 1)).toBe(true); expect(lifecycleList({ ...page, operations: [good, good] }, I, 2)).toBe(false);
  expect(lifecycleList({ ...page, scopeId: "c".repeat(64) }, I, 1)).toBe(false);
  const preview = { requestId: r.requestId, operationRef: good.operationRef, scopeId: scope, planRevision: plan, kind: r.kind, sourceBotRef: r.sourceBotRef,
    targetName: r.name, modelId: null, instructionsSha256: plan, activate: r.activate, start: r.start, maxRunMs: r.maxRunMs, materialPolicy: "best-effort-with-gaps", planPersisted: false, nativeEffectsPerformed: false, sourceDeleted: false };
  expect(lifecyclePreview(preview, I, r)).toBe(true); expect(lifecyclePreview({ ...preview, sourceDeleted: true }, I, r)).toBe(false);
});

test("preview content digest must match the captured instructions, not merely look like a hash", async () => {
  const r = intent(), ref = lifecycleReference(I, scope, r.requestId);
  const response = { requestId: r.requestId, operationRef: ref, scopeId: scope, planRevision: plan, kind: r.kind, sourceBotRef: r.sourceBotRef,
    targetName: r.name, modelId: null, instructionsSha256: plan, activate: r.activate, start: r.start, maxRunMs: r.maxRunMs,
    materialPolicy: "best-effort-with-gaps", planPersisted: false, nativeEffectsPerformed: false, sourceDeleted: false };
  const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "key",
    fetch: (async () => envelope(response)) as unknown as typeof fetch });
  await expect(client.previewLifecycle(r)).rejects.toMatchObject({ code: "protocol_error" });
});

test("a mismatched successful lifecycle reply remains unknown with the original recovery locator", async () => {
  const r = intent(); let calls = 0;
  const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "key", fetch: (async () => { calls++; return envelope({ ...receipt(r), requestId: randomUUID() }); }) as unknown as typeof fetch });
  await expect(client.submitLifecycle({ ...r, scopeId: scope, planRevision: plan, confirmed: true })).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: r.requestId, lookupPath: `/v1/lifecycle-operations/${scope}/${r.requestId}` } });
  expect(calls).toBe(1);
});

test("credential delay cannot replace lifecycle input or original request identity", async () => {
  const r = { ...intent(), scopeId: scope, planRevision: plan, confirmed: true as const }, original = structuredClone(r);
  let release!: () => void, seen: unknown; const gate = new Promise<void>(done => { release = done; });
  const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => { await gate; return "key"; },
    fetch: (async (_url, init) => { seen = JSON.parse(String(init?.body)); return envelope(receipt(original)); }) as typeof fetch });
  const pending = client.submitLifecycle(r); r.requestId = randomUUID(); r.instructions = "changed"; release(); await pending; expect(seen).toEqual(original);
});

test("preview interruption is not a mutating unknown and bad resume sends no request", async () => {
  let calls = 0; const client = new ManagementClient({ baseUrl: "https://management.example.test", installationId: I, credential: async () => "key",
    fetch: (async () => { calls++; throw Error("fixture-disconnected"); }) as unknown as typeof fetch });
  await expect(client.previewLifecycle(intent())).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toBe(1);
  expect(() => client.resumeLifecycle({ requestId: "wrong", scopeId: scope, planRevision: plan, confirmed: true })).toThrow();
  expect(() => client.lifecycle(lifecycleReference(randomUUID(), scope, randomUUID()))).toThrow();
  expect(calls).toBe(1);
});
