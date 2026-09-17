import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { configurationRevisions, defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { STUB_ECHO_MODEL } from "@grokbox/runtime-kernel/selection";
import { openConfigStore, commitConfigChange } from "../packages/box-runtime/src/internal/io/config-store.node.ts";
import { rootConfigLayout, publishConfigFile } from "../packages/box-runtime/src/internal/io/config-layout.node.ts";
import { captureHostManagedSelection } from "../packages/box-runtime/src/internal/host/selection.node.ts";
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
