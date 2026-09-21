import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submitModelChange } from "./model-management-fixture.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
import { parseModelsFile, type DesiredFile } from "@grokbox/runtime-kernel/selection";
import type { RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { ownedOwnershipReader, ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const env = { OWNED_KEY: "owned-test-key" };
function catalogFetch(ids: string[] = ["second"], status = 200): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(url).toMatch(/\/v1\/models$/);
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status });
  }) as typeof fetch;
}
function fixture() {
  let models = parseModelsFile({ version: 3,
    models: { "openai/second": { provider: "openai", model: "second", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 200000 } },
    assignments: { main: null, agents: { [A]: { modelId: "stub/echo" }, [B]: { modelId: "stub/echo" } } },
  });
  let writes = 0;
  const desired: DesiredFile = { version: 1, mode: "route" };
  const root = mkdtempSync(join(tmpdir(), "model-selection-current-")); roots.push(root);
  const store: RuntimeStore = { root,
    loadModels: async () => structuredClone(models), loadDesired: async () => desired,
    saveModels: async next => { writes++; models = structuredClone(next); },
    saveDesired: async () => { throw Error("global-mode-mutation-forbidden"); },
  };
  return { store, get: () => structuredClone(models), set: (next: typeof models) => { models = next; }, writes: () => writes };
}

test("route per-Bot official/custom/official selection changes no other assignment or global mode", async () => {
  const f = fixture();
  const ownershipRead = ownedOwnershipReader(4242);
  for (const modelId of [undefined, "openai/second", undefined]) {
    const result = await submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: modelId ? { kind: "model", modelId } : { kind: "native" } }, ownershipRead, env, fetch: catalogFetch() });
    expect(result).toMatchObject({ state: "succeeded", command: "bot-selection", target: A, currentTurn: "unchanged", effectiveWhen: "next-turn" });
    if (modelId === undefined) expect(f.get().assignments.agents).not.toHaveProperty(A);
    else expect(f.get().assignments.agents[A]?.modelId).toBe(modelId);
    expect(f.get().assignments.agents[B]?.modelId).toBe("stub/echo");
    expect(await f.store.loadDesired()).toEqual({ version: 1, mode: "route" });
  }
  expect(f.writes()).toBe(3);
});

const refusal = {
  conflict: { code: "runtime_ownership_conflict", next: `grokbox agents ownership ${A}`, failureCode: "harness_mismatch" },
  temporal: { code: "runtime_ownership_temporal", next: `grokbox agents ownership ${A}`, failureCode: "confirmed_temporal" },
  unconfirmed: { code: "runtime_ownership_unconfirmed", next: `grokbox agents ownership ${A}` },
  "missing-reader": { code: "runtime_ownership_unavailable", next: "grokbox doctor", failureCode: "ownership_reader_unavailable" },
  "old-bridge": { code: "runtime_ownership_unavailable", next: "grokbox doctor" },
  stale: { code: "runtime_ownership_unconfirmed", next: `grokbox agents ownership ${A}`, failureCode: "ownership_evidence_stale" },
} as const;

for (const mode of ["conflict", "temporal", "unconfirmed", "missing-reader", "old-bridge", "stale", "cancelled"] as const) {
  test(`${mode} refuses before any selection write`, async () => {
    const f = fixture();
    const before = f.get();
    const abort = new AbortController();
    if (mode === "cancelled") abort.abort();
    const ownershipRead = mode === "missing-reader" ? undefined : async (ids: string[]) => {
      const snapshot: Record<string, unknown> = ownedOwnershipSnapshot(mode === "unconfirmed" ? ["zzzz"] : ids, {
        ...(mode === "conflict" ? { serverHarness: "temporal" as const } : {}),
        ...(mode === "temporal" ? { serverHarness: "temporal" as const, localHarness: "temporal" as const } : {}),
        ...(mode === "stale" ? { nowMs: Date.now() - 60_000 } : {}),
      });
      if (mode === "old-bridge") { snapshot.schemaVersion = 1; delete snapshot.scope; }
      return { snapshot, gateway: { pid: 4242, startedAt: 1 } };
    };
    const rejected = submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: "openai/second" } }, ownershipRead, signal: abort.signal, env, fetch: catalogFetch() });
    if (mode === "cancelled") {
      await expect(rejected).rejects.toBeDefined();
    } else {
      await expect(rejected).rejects.toMatchObject(refusal[mode]);
      const error = await rejected.then(() => null, (value) => value) as { message: string; next: string; failureCode: string };
      expect(error.message).not.toBe(error.failureCode);
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.next).not.toContain("host on");
    }
    expect(f.writes()).toBe(0);
    expect(f.get()).toEqual(before);
  });
}

test("explicit reset removes only managed intent even when execution ownership cannot admit", async () => {
  for (const state of ["conflict", "paused", "unavailable", "missing-reader"] as const) {
    const f = fixture();
    const before = f.get();
    let reads = 0;
    const ownershipRead = state === "missing-reader" ? undefined : async (ids: string[]) => {
      reads++;
      if (state === "unavailable") throw new Error("owned-unavailable");
      return { snapshot: ownedOwnershipSnapshot(ids, { serverHarness: "temporal" }), gateway: { pid: 4242, startedAt: 1 } };
    };
    const result = await submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } }, ownershipRead });
    expect(result).toMatchObject({ state: "succeeded", currentTurn: "unchanged", effectiveWhen: "next-turn" });
    expect(reads).toBe(0);
    expect(f.get()).toEqual({ ...before, assignments: { ...before.assignments, agents: { [B]: { modelId: "stub/echo" } } } });
    expect(f.writes()).toBe(1);
  }
});

test("reset still refuses cancelled or unreadable configuration without any write", async () => {
  const f = fixture();
  await expect(submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } }, signal: AbortSignal.abort() })).rejects.toBeDefined();
  await expect(submitModelChange({ store: { ...f.store, loadModels: async () => { throw Error("owned-unavailable"); } }, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } })).rejects.toBeDefined();
  expect(f.writes()).toBe(0);
  expect(f.get().assignments.agents[A]?.modelId).toBe("stub/echo");
});

test("another writer changing configuration during ownership read is not overwritten", async () => {
  const f = fixture();
  const ownershipRead = async (ids: string[]) => {
    f.set({ ...f.get(), assignments: { main: { modelId: "stub/echo" }, agents: { [B]: { modelId: "openai/second" } } } });
    return { snapshot: ownedOwnershipSnapshot(ids), gateway: { pid: 4242, startedAt: 1 } };
  };
  await expect(submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: "openai/second" } }, ownershipRead, env, fetch: catalogFetch() })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.writes()).toBe(0);
  expect(f.get().assignments).toEqual({ main: { modelId: "stub/echo" }, agents: { [B]: { modelId: "openai/second" } } });
});

test("invalid model is refused without even consulting Server; default-only selection does not opt in Bots", async () => {
  const f = fixture();
  let reads = 0;
  const read = async (ids: string[]) => { reads++; return { snapshot: ownedOwnershipSnapshot(ids), gateway: { pid: 4242, startedAt: 1 } }; };
  await expect(submitModelChange({ store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: "openai/missing" } }, ownershipRead: read })).rejects.toBeDefined();
  expect(reads).toBe(0);
  const before = f.get().assignments.agents;
  await submitModelChange({ store: f.store, change: { kind: "default-selection", selection: { modelId: "stub/echo" } }, ownershipRead: read });
  expect(reads).toBe(0);
  expect(f.get().assignments.agents).toEqual(before);
  await submitModelChange({ store: f.store, change: { kind: "default-selection", selection: null } });
  expect(f.get().assignments.main).toBeNull();
  expect(f.get().assignments.agents).toEqual(before);
});

test("GET /v1/models failure or missing id refuses before any selection write", async () => {
  const ownershipRead = ownedOwnershipReader(4242);
  for (const fetch of [catalogFetch(["second"], 503), catalogFetch(["other"])]) {
    const f = fixture();
    await expect(submitModelChange({
      store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: "openai/second" } }, ownershipRead, env, fetch,
    })).rejects.toMatchObject({ code: "invalid_usage" });
    expect(f.writes()).toBe(0);
    expect(f.get().assignments.agents[A]?.modelId).toBe("stub/echo");
  }
});

test("GET /v1/models listing the model allows the assignment write", async () => {
  const f = fixture();
  await submitModelChange({
    store: f.store, change: { kind: "bot-selection", agentId: A, selection: { kind: "model", modelId: "openai/second" } }, ownershipRead: ownedOwnershipReader(4242), env, fetch: catalogFetch(["second"]),
  });
  expect(f.get().assignments.agents[A]?.modelId).toBe("openai/second");
  expect(f.writes()).toBe(1);
});
