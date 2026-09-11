import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { STUB_ECHO_MODEL_ID, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { saveRuntimeModels } from "../src/internal/io/configuration-write.node.ts";

const models = parseModelsFile({
  version: 1,
  models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" } },
  assignments: { main: STUB_ECHO_MODEL_ID, agents: {} },
});

describe("T29 live configuration write", () => {
  test("atomic save returns configRevision; wrong boxRoot refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "t29-config-"));
    const store = openRuntimeStore(root, {});
    const saved = await saveRuntimeModels(store, models);
    expect(saved.configRevision).toMatch(/^[a-f0-9]{64}$/);
    expect((await store.loadModels()).assignments.main).toBe(STUB_ECHO_MODEL_ID);
    await expect(saveRuntimeModels(store, models, "/tmp/other-box")).rejects.toBeInstanceOf(BoxRuntimeError);
  });
});
