import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyUse, parseModelsFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore, type RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { submitModelChange } from "./model-management-fixture.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import { reasoningModel } from "./reasoning-fixture.ts";
import { captureCli, parseJson } from "../../../test/helpers.ts";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture() {
  const record = reasoningModel();
  let file = parseModelsFile({ version: 3, models: { [record.id]: record }, assignments: { main: null, agents: { [A]: { modelId: record.id }, [B]: { modelId: record.id } } } });
  let writes = 0, ownership = 0, calls = 0;
  const root = mkdtempSync(join(tmpdir(), "reasoning-current-")); roots.push(root);
  const store: RuntimeStore = { root, loadModels: async () => structuredClone(file),
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
    const receipt = await submitModelChange({ ...f, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: f.record.id, ...(effort === "xhigh" ? { reasoning: { effort } } : {}) } }, env: { FIXTURE_KEY: "synthetic" } });
    expect(receipt).toMatchObject({ state: "succeeded", currentTurn: "unchanged", effectiveWhen: "next-turn" });
    expect(f.get().assignments.agents[B]).toEqual({ modelId: f.record.id });
    expect(f.get().assignments.agents[A]?.reasoning?.effort).toBe(effort === "xhigh" ? "xhigh" : undefined);
  }
  await submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } });
  expect(f.get().assignments.agents[A]).toBeUndefined();
  expect(f.counts()).toEqual({ writes: 4, ownership: 3, calls: 3 });
});
test("invalid/unknown/unsupported effort refuses before ownership, credentials, catalog HTTP or write", async () => {
  for (const [effort, capability] of [["INVALID", undefined], ["xhigh", undefined], ["xhigh", false], ["none", { efforts: ["high"] }]] as const) {
    const f = fixture(), next = structuredClone(f.get());
    if (capability === undefined) delete next.models[f.record.id]!.capabilities.reasoning;
    else next.models[f.record.id]!.capabilities.reasoning = capability as never;
    f.set(next);
    const before = JSON.stringify(f.get());
    await expect(submitModelChange({ ...f, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: f.record.id, reasoning: { effort: effort as never } } }, env: {} })).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.counts()).toEqual({ writes: 0, ownership: 0, calls: 0 }); expect(JSON.stringify(f.get())).toBe(before);
  }
});
test("removed model migration command cannot normalize or replace existing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-migration-removed-")), path = join(root, "models.json");
  try {
    const bytes = JSON.stringify({ version: 1, models: {}, assignments: { main: null, agents: { [A]: "stub/echo" } } });
    await writeFile(path, bytes, { mode: 0o600 });
    const result = await captureCli(["models", "migrate", "--confirm"], { configDir: root, boxRuntimeRoot: root, env: {}, runCommand: async () => { throw Error("no-process-work"); } });
    expect(result.code).toBe(2); expect(await readFile(path, "utf8")).toBe(bytes);
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
