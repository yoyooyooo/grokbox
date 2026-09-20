import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  ModelConfiguration, ModelManagementError, modelConfigurationRevision, modelOperationKey,
  parseModelChangeRequest, readModelOperation, runModelChange, type ModelChangeRequest,
} from "@grokbox/runtime-kernel/model-management";
import { applyUse, modelForAgent, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { modelConfigurationLayer } from "../src/internal/io/model-management.node.ts";
import { openRuntimeStore, type RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { managedModelAdmission } from "../src/internal/roots/model-management.runtime.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const caller = { installationId: "33333333-3333-4333-8333-333333333333", principalId: "owner:local" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options: { maxRecords?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-model-operations-")); roots.push(root);
  const store = openRuntimeStore(root, {});
  await store.saveModels(applyUse(parseModelsFile(undefined), "stub/echo"));
  let admissions = 0;
  const admit = managedModelAdmission({ ownershipRead: ownedOwnershipReader(4242), env: {} });
  const layer = modelConfigurationLayer(store, options);
  const run = (request: unknown) => Effect.runPromise(runModelChange(caller, request, (change, next) => {
    admissions++;
    return admit(change, next);
  }).pipe(Effect.provide(layer)));
  const request = async (agentId = A): Promise<ModelChangeRequest> => ({ requestId: randomUUID(),
    expectedRevision: modelConfigurationRevision(await store.loadModels()), change: { kind: "bot-selection", agentId, selection: { kind: "default" } } });
  return { root, store, layer, run, request, admissions: () => admissions };
}

test("real model file commit and durable replay survive later edits and loss of native admission", async () => {
  const f = await fixture();
  const request = await f.request();
  const result = await f.run(request);
  expect(result).toMatchObject({ state: "succeeded", currentTurn: "unchanged", effectiveWhen: "next-turn", requestId: request.requestId });
  expect((await f.store.loadModels()).assignments.agents[A]).toEqual({ kind: "default" });
  expect(modelForAgent(await f.store.loadModels(), A)?.id).toBe("stub/echo");
  expect(await f.run(request)).toEqual(result);
  await f.run(await f.request(B));
  expect(await f.run(request)).toEqual(result);
  expect(f.admissions()).toBe(2);
  const cold = openRuntimeStore(f.root, {});
  const replay = runModelChange(caller, request, () => Effect.fail(new Error("must-not-read-native-on-replay")));
  expect(await Effect.runPromise(replay.pipe(Effect.provide(modelConfigurationLayer(cold))))).toEqual(result);
  expect((await cold.loadModels()).assignments.agents[B]).toEqual({ kind: "default" });
});

test("request-id readback does not depend on the current configuration, native source or original body", async () => {
  const f = await fixture();
  const request = await f.request(), receipt = await f.run(request);
  const unavailable: RuntimeStore = { ...f.store, loadModels: async () => { throw Error("configuration-unavailable"); } };
  const layer = modelConfigurationLayer(unavailable);
  expect(await Effect.runPromise(readModelOperation(caller, request.requestId).pipe(Effect.provide(layer)))).toEqual(receipt);
  expect(await Effect.runPromise(readModelOperation({ ...caller, principalId: "reader:other" }, request.requestId).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(await Effect.runPromise(readModelOperation(caller, randomUUID()).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(f.admissions()).toBe(1);
});

test("removing a local model override acknowledges the local write when the imported definition becomes visible", async () => {
  const f = await fixture(), piPath = join(f.root, "synthetic-pi.json"), id = "catalog/inherited";
  await writeFile(piPath, JSON.stringify({ providers: { catalog: { api: "openai-responses", baseUrl: "https://catalog.invalid/v1",
    apiKey: "synthetic-imported-key", models: [{ id: "inherited" }] } } }), { mode: 0o600 });
  await f.store.saveModels({ ...await f.store.loadModels(), externalCatalog: [{ id: "pi", modelsPath: piPath }] });
  const initial = await f.request();
  expect((await f.run({ ...initial, change: { kind: "model-put", modelId: id,
    model: { provider: "openai-responses", model: "local-wire", endpoint: "https://local.invalid/v1", apiKeyRef: "env:LOCAL_KEY" } } })).state).toBe("succeeded");
  const request = { ...await f.request(), change: { kind: "model-delete", modelId: id } };
  const deleted = await f.run(request);
  expect(deleted.state).toBe("succeeded");
  const current = await f.store.loadModels();
  expect(current.models[id]).toMatchObject({ catalog: "pi", model: "inherited" });
  expect(deleted.configRevision).toBe(modelConfigurationRevision(current));
  expect(JSON.parse(await readFile(join(f.root, "models.json"), "utf8")).models[id]).toBeUndefined();
  expect(await f.run(request)).toEqual(deleted);
});

test("a different local write observed after publication remains unknown and is never overwritten", async () => {
  const f = await fixture(), request = await f.request();
  const concurrent: RuntimeStore = { ...f.store, saveModels: async (...args) => {
    await f.store.saveModels(...args);
    await f.store.saveModels(applyUse(await f.store.loadModels(), "stub/echo", B));
  } };
  const layer = modelConfigurationLayer(concurrent);
  const run = () => Effect.runPromise(runModelChange(caller, request, () => Effect.void).pipe(Effect.provide(layer)));
  const receipt = await run();
  expect(receipt.state).toBe("unknown");
  const bytes = await readFile(join(f.root, "models.json"), "utf8");
  expect(await run()).toEqual(receipt);
  expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(bytes);
  expect((await f.store.loadModels()).assignments.agents[B]).toEqual({ modelId: "stub/echo" });
});

test("same key with changed semantics is a conflict, not a second effect", async () => {
  const f = await fixture();
  const request = await f.request(); await f.run(request);
  const bytes = await readFile(join(f.root, "models.json"), "utf8");
  await expect(f.run({ ...request, change: { ...request.change, agentId: B } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(bytes);
  expect(f.admissions()).toBe(1);
});

test("a stale revision fails before native calls or durable operation declaration", async () => {
  const f = await fixture();
  const stale = await f.request(B);
  await f.run(await f.request());
  await expect(f.run(stale)).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.admissions()).toBe(1);
  expect(await readdir(join(f.root, "state", "model-operations"))).toHaveLength(1);
});

test("concurrent writers cannot silently overwrite each other's Bot selection", async () => {
  const f = await fixture();
  const requests = [await f.request(A), await f.request(B)];
  const results = await Promise.allSettled(requests.map(f.run));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const models = await f.store.loadModels();
  expect(Object.keys(models.assignments.agents)).toHaveLength(1);
  const remaining = Object.hasOwn(models.assignments.agents, A) ? B : A;
  await f.run(await f.request(remaining));
  expect(Object.keys((await f.store.loadModels()).assignments.agents).sort()).toEqual([A, B]);
});

test("crash after model publication leaves an unknown receipt and never repeats the write", async () => {
  const f = await fixture();
  const request = await f.request();
  let writes = 0;
  const faulty: RuntimeStore = { ...f.store, saveModels: async (...args) => {
    writes++;
    await f.store.saveModels(...args);
    throw new Error("synthetic-loss-after-publication");
  } };
  const layer = modelConfigurationLayer(faulty);
  const run = () => Effect.runPromise(runModelChange(caller, request, managedModelAdmission({ ownershipRead: ownedOwnershipReader(4242) })).pipe(Effect.provide(layer)));
  const result = await run();
  expect(result.state).toBe("unknown");
  expect((await f.store.loadModels()).assignments.agents[A]).toEqual({ kind: "default" });
  expect(await run()).toEqual(result);
  expect(writes).toBe(1);
  const cold = modelConfigurationLayer(openRuntimeStore(f.root, {}));
  expect(await Effect.runPromise(runModelChange(caller, request, () => Effect.die("must-not-replay" )).pipe(Effect.provide(cold)))).toEqual(result);
  const key = modelOperationKey(caller, parseModelChangeRequest(request));
  expect(await Effect.runPromise(Effect.gen(function* () { return yield* (yield* ModelConfiguration).lookup(key); }).pipe(Effect.provide(cold)))).toEqual(result);
});

test("full history rejects new writes but does not hide or evict old receipts", async () => {
  const f = await fixture({ maxRecords: 1 });
  const first = await f.request(), receipt = await f.run(first);
  await expect(f.run(await f.request(B))).rejects.toMatchObject({ code: "store_full" });
  expect(await f.run(first)).toEqual(receipt);
  expect((await f.store.loadModels()).assignments.agents[B]).toBeUndefined();
});

test("principal and installation identities namespace request receipts", async () => {
  const f = await fixture();
  const request = await f.request(); await f.run(request);
  const parsed = parseModelChangeRequest(request);
  const key = modelOperationKey({ ...caller, principalId: "reader:other" }, parsed);
  const scoped = yieldLookup(key, f.layer);
  expect(await scoped).toBeUndefined();
  expect(modelOperationKey({ ...caller, installationId: "44444444-4444-4444-8444-444444444444" }, parsed).operationRef)
    .not.toBe(modelOperationKey(caller, parsed).operationRef);
});
function yieldLookup(key: ReturnType<typeof modelOperationKey>, layer: ReturnType<typeof modelConfigurationLayer>) {
  return Effect.runPromise(Effect.gen(function* () { return yield* (yield* ModelConfiguration).lookup(key); }).pipe(Effect.provide(layer)));
}

test("read-only model and receipt lookups never initialize a missing root", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-model-read-")); roots.push(root);
  const absent = join(root, "not-created");
  const layer = modelConfigurationLayer(openRuntimeStore(absent, {}));
  await Effect.runPromise(Effect.gen(function* () { return yield* (yield* ModelConfiguration).read(); }).pipe(Effect.provide(layer)));
  const request = { requestId: randomUUID(), expectedRevision: "0".repeat(64), change: { kind: "bot-selection" as const, agentId: A, selection: { kind: "native" as const } } };
  expect(await yieldLookup(modelOperationKey(caller, request), layer)).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

test("writable-by-others model files and directories are refused without changing their bytes", async () => {
  const f = await fixture();
  const request = await f.request();
  const path = join(f.root, "models.json");
  const before = await readFile(path, "utf8");
  await chmod(path, 0o666);
  await expect(f.run(request)).rejects.toMatchObject({ code: "unavailable" });
  await chmod(path, 0o600);
  await chmod(join(f.root, "state"), 0o777);
  await expect(f.run(request)).rejects.toMatchObject({ code: "unavailable" });
  expect(await readFile(path, "utf8")).toBe(before);
});

test("symlinked model data cannot become a second writer", async () => {
  const f = await fixture();
  const request = await f.request();
  const outside = join(f.root, "outside.json"), model = join(f.root, "models.json");
  await writeFile(outside, await readFile(model), { mode: 0o600 });
  await rm(model); await symlink(outside, model);
  await expect(f.run(request)).rejects.toMatchObject({ code: "unavailable" });
  expect((await readFile(outside, "utf8"))).not.toContain(A);
});

test("symlinked receipt directories and injected receipt fields are refused before admission", async () => {
  const f = await fixture();
  const request = await f.request();
  await f.run(request);
  const directory = join(f.root, "state", "model-operations");
  const [name] = await readdir(directory);
  const path = join(directory, name!);
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...record, operation: { ...record.operation, credential: "synthetic-secret" } }), { mode: 0o600 });
  await expect(f.run(request)).rejects.toMatchObject({ code: "unavailable" });
  const outside = join(f.root, "outside"); await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, name!), JSON.stringify(record), { mode: 0o600 });
  await rm(directory, { recursive: true }); await symlink(outside, directory);
  await expect(f.run(request)).rejects.toMatchObject({ code: "unavailable" });
  expect(f.admissions()).toBe(1);
});

test("client interruption during publication settles the durable write before releasing ownership", async () => {
  const f = await fixture();
  const request = await f.request();
  let enter!: () => void, release!: () => void, writes = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store: RuntimeStore = { ...f.store, saveModels: async (...args) => { writes++; enter(); await gate; await f.store.saveModels(...args); } };
  const controller = new AbortController();
  const pending = Effect.runPromise(runModelChange(caller, request, managedModelAdmission({ ownershipRead: ownedOwnershipReader(4242) }))
    .pipe(Effect.provide(modelConfigurationLayer(store))), { signal: controller.signal });
  await entered;
  controller.abort(); release();
  await pending.catch(() => undefined);
  expect(writes).toBe(1);
  const receipt = await f.run(request);
  expect(receipt.state).toBe("succeeded");
  expect(f.admissions()).toBe(0);
  expect(await readdir(join(f.root, "state"))).not.toContain("model-operations.lock");
});

test("malformed model records are rejected before receipt declaration", async () => {
  const f = await fixture();
  const request = await f.request();
  const model = { provider: "openai", model: "test", endpoint: "https://models.invalid/v1", apiKeyRef: "env:SYNTHETIC_KEY" };
  for (const bad of [
    { ...model, capabilities: { tools: "yes" } }, { ...model, capabilities: null },
    { ...model, dataTypes: ["text", 42] }, { ...model, catalog: "pi" },
    { ...model, id: "wrong/model" }, { ...model, endpoint: "https://user:synthetic-secret@models.invalid/v1" },
    { ...model, endpoint: "https://models.invalid/v1?api_key=synthetic-secret" },
    { ...model, apiKeyRef: "synthetic-secret" },
  ]) {
    await expect(f.run({ ...request, change: { kind: "model-put", modelId: "test/model", model: bad } })).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(f.admissions()).toBe(0);
  expect(await readdir(join(f.root, "state"))).not.toContain("model-operations");
});

test("untrusted input fails before ownership reads and does not echo secrets", async () => {
  const f = await fixture();
  const request = await f.request();
  for (const input of [
    { ...request, extra: "synthetic-secret" }, { ...request, requestId: "not-a-uuid" },
    { ...request, change: { kind: "bot-selection", agentId: "name-not-id", selection: { kind: "default" } } },
    { ...request, change: { ...request.change, selection: { kind: "default", modelId: "stub/echo" } } },
  ]) {
    const error = await f.run(input).then(() => null, error => error);
    expect(error).toBeInstanceOf(ModelManagementError);
    expect(error.code).toBe("invalid_input");
    expect(error.message).not.toContain("synthetic-secret");
  }
  expect(f.admissions()).toBe(0);
  expect(await readdir(join(f.root, "state"))).not.toContain("model-operations");
});

test("reset is possible without ownership but becoming a follower is not", async () => {
  const f = await fixture();
  const request = await f.request();
  await expect(Effect.runPromise(runModelChange(caller, request, managedModelAdmission({})).pipe(Effect.provide(f.layer))))
    .rejects.toMatchObject({ code: "runtime_ownership_unavailable" });
  const result = await Effect.runPromise(runModelChange(caller, { ...request, change: { ...request.change, selection: { kind: "native" } } }, managedModelAdmission({})).pipe(Effect.provide(f.layer)));
  expect(result.state).toBe("succeeded");
});
