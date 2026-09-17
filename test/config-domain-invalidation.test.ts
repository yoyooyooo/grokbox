import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { configurationRevisions, defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { STUB_ECHO_MODEL, parseModelsFile, applyUse } from "@grokbox/runtime-kernel/selection";
import { openConfigStore, commitConfigChange } from "../packages/box-runtime/src/internal/io/config-store.node.ts";
import { rootConfigLayout, publishConfigFile } from "../packages/box-runtime/src/internal/io/config-layout.node.ts";
import { captureHostManagedSelection } from "../packages/box-runtime/src/internal/host/selection.node.ts";
import { saveRuntimeModels } from "../packages/box-runtime/src/internal/io/configuration-write.node.ts";
import { openRuntimeStore } from "../packages/box-runtime/src/internal/io/configuration.node.ts";

const agent = "00000000-0000-4000-8000-000000000321";

describe("configuration domain isolation through production readers", () => {
  test("client and desktop edits preserve Host model capture, ops policy and runtime intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-config-domains-"));
    await publishConfigFile(join(root, "config.json"), validateConfig({ ...defaultConfig(), runtime: { desiredMode: "route" },
      ops: { targets: { default: {}, analysis: { allowedIntents: ["diagnose-or-report"] } } } }));
    const models = JSON.stringify({ version: 1, models: { "stub/echo": STUB_ECHO_MODEL }, assignments: { main: null, agents: { [agent]: "stub/echo" } } });
    await writeFile(join(root, "models.json"), models, { mode: 0o600 });
    const store = openConfigStore(rootConfigLayout(root)); const before = configurationRevisions((await store.read()).document);
    const captured = captureHostManagedSelection(root, agent);
    expect(captured.kind).toBe("managed");
    await commitConfigChange(store, { operationId: randomUUID(), scope: "box", kind: "set", path: "desktop.idleReclaim.minIdleMs", value: 900000 });
    await commitConfigChange(store, { operationId: randomUUID(), scope: "client", kind: "set", path: "client.profiles.default.transport", value: "local" });
    const after = configurationRevisions((await store.read()).document);
    expect(after.config).not.toBe(before.config); expect(after.desktop).not.toBe(before.desktop);
    expect(after.runtime).toBe(before.runtime); expect(after.ops).toBe(before.ops);
    expect(after.targets).toEqual(before.targets); expect(after.support).toBe(before.support);
    expect(captureHostManagedSelection(root, agent)).toEqual(captured);
    expect(await openRuntimeStore(root).loadDesired()).toEqual({ version: 1, mode: "route" });
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(models);
  });
  test("changing one target does not invalidate another target or create a machine binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-config-targets-"));
    const document = validateConfig({ ...defaultConfig(), ops: { targets: { default: {}, analysis: {} } } });
    await publishConfigFile(join(root, "config.json"), document);
    const before = configurationRevisions(document); const store = openConfigStore(rootConfigLayout(root));
    await commitConfigChange(store, { operationId: randomUUID(), scope: "box", kind: "set", path: "ops.targets.analysis.dataPolicy", value: "diagnostic-summary", confirm: true });
    const after = configurationRevisions((await store.read()).document);
    expect(after.targets.default).toBe(before.targets.default);
    expect(after.targets.analysis).not.toBe(before.targets.analysis);
    expect(after.support).toBe(before.support);
    expect(await readFile(join(root, "state", "ops-bindings.json"), "utf8").catch(() => "absent")).toBe("absent");
    expect(await readFile(join(root, "state", "ops-grants.json"), "utf8").catch(() => "absent")).toBe("absent");
  });
});

test("reasoning policy and unified general config do not rewrite or invalidate each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-reasoning-domains-"));
  const configPath = join(root, "config.json"), modelsPath = join(root, "models.json");
  await publishConfigFile(configPath, validateConfig({ ...defaultConfig(), runtime: { desiredMode: "route" } }));
  const modelId = "example/model";
  const file = parseModelsFile({ version: 2, models: { [modelId]: { provider: "openai-responses", model: "example",
    endpoint: "https://example.invalid/v1", apiKeyRef: "env:SYNTHETIC_KEY", contextWindowTokens: 200000,
    capabilities: { reasoning: { efforts: ["high", "xhigh"] } } } }, assignments: { main: null, agents: {} } });
  const runtime = openRuntimeStore(root, {}), config = openConfigStore(rootConfigLayout(root));
  await saveRuntimeModels(runtime, applyUse(file, modelId, agent, { effort: "high" }));
  const captured = captureHostManagedSelection(root, agent), modelBytes = await readFile(modelsPath, "utf8");
  await commitConfigChange(config, { operationId: randomUUID(), scope: "box", kind: "set", path: "desktop.idleReclaim.minIdleMs", value: 900000 });
  expect(captureHostManagedSelection(root, agent)).toEqual(captured);
  expect(await readFile(modelsPath, "utf8")).toBe(modelBytes);
  const configBytes = await readFile(configPath, "utf8"), revisions = configurationRevisions((await config.read()).document);
  await saveRuntimeModels(runtime, applyUse(await runtime.loadModels(), modelId, agent, { effort: "xhigh" }));
  expect(await readFile(configPath, "utf8")).toBe(configBytes);
  expect(configurationRevisions((await config.read()).document)).toEqual(revisions);
  const changed = captureHostManagedSelection(root, agent);
  expect(changed.kind).toBe("managed");
  if (changed.kind === "managed" && captured.kind === "managed") {
    expect(changed.modelId).toBe(captured.modelId); expect(changed.selectionRevision).not.toBe(captured.selectionRevision);
    expect(changed.record.reasoning?.effort).toBe("xhigh");
  }
});
