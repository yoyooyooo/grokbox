import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { submitModelChange } from "./model-management-fixture.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import { STUB_ECHO_MODEL_ID, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { saveRuntimeModels } from "../src/internal/io/configuration-write.node.ts";

const models = parseModelsFile({
  version: 3,
  models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" } },
  assignments: { main: { modelId: STUB_ECHO_MODEL_ID }, agents: {} },
});

describe("shared configuration commit boundary", () => {
  test("two stale model writers cannot both succeed; explicit retry preserves the first Bot", async () => {
    const root = mkdtempSync(join(tmpdir(), "gbox-model-cas-"));
    const store = openRuntimeStore(root, {});
    await store.saveModels(models);
    await store.saveDesired({ version: 1, mode: "route" });
    const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    const base = await store.loadModels();
    const revision = sha256Text(canonicalJson(base));
    const next = (id: string) => ({ ...base, assignments: { ...base.assignments, agents: { [id]: { modelId: STUB_ECHO_MODEL_ID } } } });
    const results = await Promise.allSettled([saveRuntimeModels(store, next(A), root, revision), saveRuntimeModels(store, next(B), root, revision)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? A : B;
    const loser = winner === A ? B : A;
    expect((await store.loadModels()).assignments.agents).toEqual({ [winner]: { modelId: STUB_ECHO_MODEL_ID } });
    await expect(saveRuntimeModels(store, next(loser), root, revision)).rejects.toBeDefined();
    await submitModelChange({ store, change: { kind: "bot-selection", agentId: loser, selection: { kind: "model", modelId: STUB_ECHO_MODEL_ID } }, ownershipRead: ownedOwnershipReader(4242) });
    expect((await store.loadModels()).assignments.agents).toEqual({ [A]: { modelId: STUB_ECHO_MODEL_ID }, [B]: { modelId: STUB_ECHO_MODEL_ID } });
  });

  test("atomic save returns configRevision; wrong boxRoot refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "t29-config-"));
    const store = openRuntimeStore(root, {});
    const saved = await saveRuntimeModels(store, models);
    expect(saved.configRevision).toMatch(/^[a-f0-9]{64}$/);
    expect((await store.loadModels()).assignments.main?.modelId).toBe(STUB_ECHO_MODEL_ID);
    await expect(saveRuntimeModels(store, models, "/tmp/other-box")).rejects.toBeInstanceOf(BoxRuntimeError);
  });
});
