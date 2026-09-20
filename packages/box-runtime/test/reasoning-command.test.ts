import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyUse, parseModelsFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore, type RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { changeRuntimeModel, migrateRuntimeModels } from "../src/internal/io/model-selection.node.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import { reasoningModel } from "./reasoning-fixture.ts";
import { captureCli, parseJson } from "../../../test/helpers.ts";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const record = reasoningModel();
  let file = parseModelsFile({ version: 2, models: { [record.id]: record }, assignments: { main: null, agents: { [A]: { modelId: record.id }, [B]: { modelId: record.id } } } });
  let writes = 0, ownership = 0, calls = 0;
  const store: RuntimeStore = { root: "/synthetic/reasoning-selection", loadModels: async () => structuredClone(file),
    loadDesired: async () => ({ version: 1, mode: "route" }), saveDesired: async () => { throw Error("global-write"); },
    saveModels: async next => { writes++; file = structuredClone(next); } };
  const fetch = Object.assign(async (_url: unknown) => { calls++; return Response.json({ data: [{ id: record.model }] }); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const reader = ownedOwnershipReader(4242);
  return { store, fetch, record, get: () => file, set: (next: ModelsFile) => { file = next; },
    ownershipRead: async (...args: Parameters<typeof reader>) => { ownership++; return reader(...args); },
    counts: () => ({ writes, ownership, calls }) };
}
test("selection admission primitive saves explicit effort/default/reset without changing the other Bot", async () => {
  const f = fixture();
  for (const effort of ["xhigh", "default", undefined]) {
    const receipt = await changeRuntimeModel({ ...f, forAgent: A, modelId: f.record.id, effort, env: { FIXTURE_KEY: "synthetic" } });
    expect(receipt).toMatchObject({ selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed", reasoning: { requested: effort === "xhigh" ? "xhigh" : "default", providerReported: "unknown" } });
    expect(f.get().assignments.agents[B]).toEqual({ modelId: f.record.id });
    expect(f.get().assignments.agents[A]?.reasoning?.effort).toBe(effort === "xhigh" ? "xhigh" : undefined);
  }
  await changeRuntimeModel({ store: f.store, forAgent: A });
  expect(f.get().assignments.agents[A]).toBeUndefined();
  expect(f.counts()).toEqual({ writes: 4, ownership: 3, calls: 3 });
});
test("invalid/unknown/unsupported effort refuses before ownership, credentials, catalog HTTP or write", async () => {
  for (const [effort, capability] of [["INVALID", undefined], ["xhigh", undefined], ["xhigh", false], ["none", { efforts: ["high"] }]] as const) {
    const f = fixture(), next = structuredClone(f.get()); next.models[f.record.id]!.capabilities.reasoning = capability as never; f.set(next);
    const before = JSON.stringify(f.get());
    await expect(changeRuntimeModel({ ...f, forAgent: A, modelId: f.record.id, effort, env: {} })).rejects.toMatchObject({ code: "invalid_usage" });
    expect(f.counts()).toEqual({ writes: 0, ownership: 0, calls: 0 }); expect(JSON.stringify(f.get())).toBe(before);
  }
});
test("explicit migration is confirmation-gated, read-only until save, idempotent and cancellable", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-migrate-")), path = join(root, "models.json");
  const legacy = { version: 1, models: {}, assignments: { main: null, agents: { [A]: "stub/echo", [B]: "stub/echo" } } };
  try {
    const bytes = JSON.stringify(legacy); await writeFile(path, bytes, { mode: 0o600 });
    const store = openRuntimeStore(root, {});
    expect((await store.loadModels()).version).toBe(3); expect(await readFile(path, "utf8")).toBe(bytes);
    await expect(migrateRuntimeModels({ store, confirmed: false })).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(migrateRuntimeModels({ store, confirmed: true, signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await migrateRuntimeModels({ store, confirmed: true })).toMatchObject({ modelsSchemaVersion: 3, assignmentsUnchanged: true, effectiveUse: "not_observed" });
    const migrated = await readFile(path, "utf8");
    expect(JSON.parse(migrated).assignments.agents[A]).toEqual({ modelId: "stub/echo" });
    await migrateRuntimeModels({ store, confirmed: true }); expect(await readFile(path, "utf8")).toBe(migrated);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("model projection requires the management service and never reads local models as a fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-show-"));
  try {
    const f = fixture(), store = openRuntimeStore(root, {});
    await store.saveModels(applyUse(f.get(), f.record.id, A, { effort: "xhigh" }));
    const before = await readFile(join(root, "models.json"), "utf8");
    const result = await captureCli(["bot", "model", "get", A], { configDir: root, boxRuntimeRoot: root, env: {}, transport: "local" });
    expect(result.code).toBe(7); expect(result.stderr).toBe("");
    expect(parseJson(result.stdout)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
