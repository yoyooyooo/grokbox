import { expect, test } from "bun:test";
import { ManagementClient, botRef, type ModelChangeRequest } from "../src/client.ts";

const I = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const revision = "a".repeat(64);
const model = { id: "channel/first", provider: "openai-responses", model: "first", alias: null,
  endpoint: "https://models.invalid/v1", configurationSource: "local", capabilities: { vision: false, tools: true, images: false },
  contextWindowTokens: null, credential: { configured: false, source: "none" } };
const selection = { botRef: botRef(I, A), selection: { kind: "native" }, revision, effectiveModel: null,
  effectiveWhen: "next-turn", currentTurn: "not-observed", source: "model-configuration" };
const receipt = { version: 1, operationRef: `model-operation:${I}:${"b".repeat(64)}`, requestId: R,
  command: "bot-selection", target: A, state: "succeeded", beforeRevision: revision, configRevision: "c".repeat(64),
  acceptedAt: "2026-09-19T16:00:00.000Z", effectiveWhen: "next-turn", currentTurn: "unchanged", concurrency: "local_serialized" };
const input = (): ModelChangeRequest => ({ requestId: R, expectedRevision: revision,
  change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } });
const reply = (data: unknown) => Response.json({ schemaVersion: 1, installationId: I, invocationId: B, ok: true, data });
function client(data: unknown) {
  let calls = 0;
  const transport = Object.assign(async () => { calls++; return reply(data); }, { preconnect: () => undefined }) as typeof fetch;
  return { value: new ManagementClient({ baseUrl: "http://127.0.0.1:3101", installationId: I, fetch: transport }), calls: () => calls };
}

test("model reads bind the response to the requested model identity", async () => {
  const f = client({ model: { ...model, id: "channel/other" }, revision });
  await expect(f.value.model(model.id)).rejects.toMatchObject({ code: "protocol_error" });
  expect(f.calls()).toBe(1);
});

test("Bot model reads require the requested scoped identity and complete adoption semantics", async () => {
  for (const data of [
    { ...selection, botRef: botRef(I, B) }, { ...selection, effectiveWhen: "immediate" },
    { ...selection, currentTurn: "applied" }, { ...selection, effectiveModel: undefined },
    { ...selection, selection: { kind: "model" } },
    { ...selection, selection: { kind: "native", modelId: "channel/first" } },
  ]) await expect(client(data).value.botModel(A)).rejects.toMatchObject({ code: "protocol_error" });
  expect((await client(selection).value.botModel(A)).data.botRef).toBe(botRef(I, A));
});

test("model pages reject duplicate identities, unbounded cursors and malformed public fields", async () => {
  const page = { models: [model], revision, total: 1, nextCursor: null, pageBound: null };
  for (const data of [
    { ...page, models: [model, model], total: 2 }, { ...page, nextCursor: "x".repeat(257) },
    { ...page, models: [{ ...model, capabilities: { tools: "yes" } }] },
    { ...page, models: [{ ...model, contextWindowTokens: -1 }] },
    { ...page, models: [{ ...model, endpoint: "https://user:secret@models.invalid/" }] },
  ]) await expect(client(data).value.models()).rejects.toMatchObject({ code: "protocol_error" });
  expect((await client(page).value.models()).data.total).toBe(1);
});

test("default reads reject malformed selection and policy fields", async () => {
  for (const selected of [{ modelId: "" }, { modelId: "channel/first", reasoning: { effort: "invented" } }, { modelId: "channel/first", kind: "default" }]) {
    await expect(client({ selection: selected, revision }).value.defaultModel()).rejects.toMatchObject({ code: "protocol_error" });
  }
});

test("receipt reads validate scope, command, target and historical facts", async () => {
  for (const data of [
    { ...receipt, operationRef: `model-operation:${B}:${"b".repeat(64)}` },
    { ...receipt, command: "invented" }, { ...receipt, target: "not-a-bot" },
    { ...receipt, currentTurn: "changed" }, { ...receipt, concurrency: "global_atomic" },
    { ...receipt, acceptedAt: "not-a-date" },
  ]) await expect(client(data).value.modelOperation(R)).rejects.toMatchObject({ code: "protocol_error" });
  expect((await client(receipt).value.modelOperation(R)).data.requestId).toBe(R);
});

test("unmatched successful receipt stays unknown and retains the original locator", async () => {
  for (const data of [{ ...receipt, target: B }, { ...receipt, command: "default-selection", target: "default" }, { ...receipt, beforeRevision: "d".repeat(64) }]) {
    const f = client(data);
    await expect(f.value.changeModels(input())).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: R, installationId: I } });
    expect(f.calls()).toBe(1);
  }
});

test("caller mutation during credential resolution cannot change the recovery locator", async () => {
  let release!: (value: string) => void;
  let body: unknown;
  const value = new ManagementClient({ baseUrl: "http://127.0.0.1:3101", installationId: I,
    credential: () => new Promise(resolve => { release = resolve; }),
    fetch: Object.assign(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(init!.body as string); throw new Error("synthetic_disconnect");
    }, { preconnect: () => undefined }) as typeof fetch });
  const original = input();
  const pending = value.changeModels(original);
  await Promise.resolve();
  original.requestId = B; original.expectedRevision = "e".repeat(64);
  release("synthetic-credential");
  await expect(pending).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: R } });
  expect(body).toMatchObject({ requestId: R, expectedRevision: revision });
});
