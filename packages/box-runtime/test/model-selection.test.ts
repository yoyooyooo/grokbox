import { expect, test } from "bun:test";
import { changeRuntimeModel } from "../src/internal/io/model-selection.node.ts";
import { parseModelsFile, type DesiredFile } from "@grokbox/runtime-kernel/selection";
import type { RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { ownedOwnershipReader, ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function fixture() {
  let models = parseModelsFile({ version: 1,
    models: { "openai/second": { provider: "openai", model: "second", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 200000 } },
    assignments: { main: null, agents: { [A]: "stub/echo", [B]: "stub/echo" } },
  });
  let writes = 0;
  const desired: DesiredFile = { version: 1, mode: "route" };
  const store: RuntimeStore = { root: "/owned/model-selection",
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
    const result = await changeRuntimeModel({ store: f.store, forAgent: A, modelId, ownershipRead });
    expect(result).toMatchObject({ selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed", ownership: modelId === undefined ? "not_required_for_reset" : "confirmed_box", blastRadius: "single_bot", takesEffect: "next_user_turn" });
    if (modelId === undefined) expect(f.get().assignments.agents).not.toHaveProperty(A);
    else expect(f.get().assignments.agents[A]).toBe(modelId);
    expect(f.get().assignments.agents[B]).toBe("stub/echo");
    expect(await f.store.loadDesired()).toEqual({ version: 1, mode: "route" });
  }
  expect(f.writes()).toBe(3);
});

for (const mode of ["conflict", "missing-reader", "old-bridge", "stale", "cancelled"] as const) {
  test(`${mode} refuses before any selection write`, async () => {
    const f = fixture();
    const before = f.get();
    const abort = new AbortController();
    if (mode === "cancelled") abort.abort();
    const ownershipRead = mode === "missing-reader" ? undefined : async (ids: string[]) => {
      const snapshot: Record<string, unknown> = ownedOwnershipSnapshot(ids, {
        ...(mode === "conflict" ? { serverHarness: "temporal" as const } : {}),
        ...(mode === "stale" ? { nowMs: Date.now() - 60_000 } : {}),
      });
      if (mode === "old-bridge") { snapshot.schemaVersion = 1; delete snapshot.scope; }
      return { snapshot, gateway: { pid: 4242, startedAt: 1 } };
    };
    await expect(changeRuntimeModel({ store: f.store, forAgent: A, modelId: "openai/second", ownershipRead, signal: abort.signal })).rejects.toBeDefined();
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
    const result = await changeRuntimeModel({ store: f.store, forAgent: A, ownershipRead });
    expect(result).toMatchObject({ ownership: "not_required_for_reset", model: "official", selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed" });
    expect(reads).toBe(0);
    expect(f.get()).toEqual({ ...before, assignments: { ...before.assignments, agents: { [B]: "stub/echo" } } });
    expect(f.writes()).toBe(1);
  }
});

test("reset still refuses cancelled or unreadable configuration without any write", async () => {
  const f = fixture();
  await expect(changeRuntimeModel({ store: f.store, forAgent: A, signal: AbortSignal.abort() })).rejects.toBeDefined();
  await expect(changeRuntimeModel({ store: { ...f.store, loadModels: async () => { throw Error("owned-unavailable"); } }, forAgent: A })).rejects.toBeDefined();
  expect(f.writes()).toBe(0);
  expect(f.get().assignments.agents[A]).toBe("stub/echo");
});

test("another writer changing configuration during ownership read is not overwritten", async () => {
  const f = fixture();
  const ownershipRead = async (ids: string[]) => {
    f.set({ ...f.get(), assignments: { main: "stub/echo", agents: { [B]: "openai/second" } } });
    return { snapshot: ownedOwnershipSnapshot(ids), gateway: { pid: 4242, startedAt: 1 } };
  };
  await expect(changeRuntimeModel({ store: f.store, forAgent: A, modelId: "openai/second", ownershipRead })).rejects.toMatchObject({ code: "invalid_usage", message: "selection_configuration_changed" });
  expect(f.writes()).toBe(0);
  expect(f.get().assignments).toEqual({ main: "stub/echo", agents: { [B]: "openai/second" } });
});

test("invalid model is refused without even consulting Server; default-only selection does not opt in Bots", async () => {
  const f = fixture();
  let reads = 0;
  const read = async (ids: string[]) => { reads++; return { snapshot: ownedOwnershipSnapshot(ids), gateway: { pid: 4242, startedAt: 1 } }; };
  await expect(changeRuntimeModel({ store: f.store, forAgent: A, modelId: "openai/missing", ownershipRead: read })).rejects.toBeDefined();
  expect(reads).toBe(0);
  const before = f.get().assignments.agents;
  await changeRuntimeModel({ store: f.store, modelId: "stub/echo", ownershipRead: read });
  expect(reads).toBe(0);
  expect(f.get().assignments.agents).toEqual(before);
  await expect(changeRuntimeModel({ store: f.store })).rejects.toMatchObject({ code: "invalid_usage" });
});
