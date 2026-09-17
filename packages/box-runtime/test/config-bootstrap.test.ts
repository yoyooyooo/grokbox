import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installConfigurationResources, prepareConfigurationBootstrap, rollbackConfigurationBootstrap,
} from "../src/internal/io/config-bootstrap.node.ts";
import { publishConfigFile, readConfigLayout, readInstallation, rootConfigLayout } from "../src/internal/io/config-layout.node.ts";
import { openConfigStore, commitConfigChange } from "../src/internal/io/config-store.node.ts";
import { captureCli, parseJson } from "../../../test/helpers.ts";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "grokbox-config-bootstrap-"));
  return { configDir: join(base, "home"), root: join(base, "durable"), operationId: "install-one" };
}
const resources = { daemon: { network: { host: "127.0.0.1" as const, port: 37134 } }, security: { daemon: { tokenSha256: "1".repeat(64) } } };

describe("canonical bootstrap installation and recovery", () => {
  test("new install creates only canonical intent/models and preserves aliases across replay", async () => {
    const input = await fixture();
    await prepareConfigurationBootstrap(input);
    expect(await stat(join(input.root, "config.json")).catch(() => null)).toBeNull();
    const receipt = await installConfigurationResources(input, resources);
    expect(receipt.phase).toBe("applied");
    const layout = await readConfigLayout(input.configDir);
    expect(layout.root).toBe(input.root);
    expect(await readlink(join(input.configDir, "config.json"))).toBe(join(input.root, "config.json"));
    const models = await readFile(join(input.root, "models.json"), "utf8");
    const before = await readFile(join(input.root, "config.json"), "utf8");
    expect(before).not.toContain(resources.security.daemon.tokenSha256);
    expect((await installConfigurationResources(input, resources)).repeated).toBe(true);
    expect(await readFile(join(input.root, "config.json"), "utf8")).toBe(before);
    expect(await readFile(join(input.root, "models.json"), "utf8")).toBe(models);
    expect(await stat(join(input.configDir, "daemon", "config.json")).catch(() => null)).toBeNull();
    expect(await installConfigurationResources(input, { ...resources, daemon: {} }).catch((error) => error.code)).toBe("config_conflict");
  });

  test("rollback restores only this attempt and never rewrites existing model bytes", async () => {
    const input = await fixture();
    await installConfigurationResources(input, resources);
    const modelText = '{ "version": 1, "models": {}, "assignments": {"agents": {}, "main": null} }\n';
    await publishConfigFile(join(input.root, "models.json"), JSON.parse(modelText), modelText);
    const before = await readFile(join(input.root, "config.json"), "utf8");
    const second = { ...input, operationId: "install-two" };
    await prepareConfigurationBootstrap(second);
    await installConfigurationResources(second, { daemon: { network: { host: "127.0.0.1", port: 40001 } }, security: { daemon: { tokenSha256: "2".repeat(64) } } });
    const rolled = await rollbackConfigurationBootstrap(second);
    expect(rolled.restartPrevious).toBe(true);
    expect(await readFile(join(input.root, "config.json"), "utf8")).toBe(before);
    expect((await readInstallation(input.root))?.daemon?.tokenSha256).toBe("1".repeat(64));
    expect(await readFile(join(input.root, "models.json"), "utf8")).toBe(modelText);
    expect((await rollbackConfigurationBootstrap(second)).phase).toBe("rolled-back");
    expect(await installConfigurationResources(second, resources).catch((error) => error.code)).toBe("config_conflict");
  });

  test("a later user edit fences rollback rather than losing the user's update", async () => {
    const input = await fixture(); await installConfigurationResources(input, resources);
    await commitConfigChange(openConfigStore(rootConfigLayout(input.root)), { operationId: "user-later", kind: "set", scope: "box", path: "desktop.idleReclaim.enabled", value: true });
    const before = await readFile(join(input.root, "config.json"), "utf8");
    expect(await rollbackConfigurationBootstrap(input).catch((error) => error.code)).toBe("config_conflict");
    expect(await readFile(join(input.root, "config.json"), "utf8")).toBe(before);
  });

  test("bad resources fail before config, models or credential verifier is published", async () => {
    const input = await fixture();
    await expect(installConfigurationResources(input, { ...resources, security: { daemon: { tokenSha256: "unsafe" } } })).rejects.toBeDefined();
    expect(await stat(join(input.root, "config.json")).catch(() => null)).toBeNull();
    expect(await stat(join(input.root, "state", "installation.json")).catch(() => null)).toBeNull();
    expect((await rollbackConfigurationBootstrap(input)).restartPrevious).toBe(false);
  });

  test("source CLI install and restore use stable IDs and never expose the verifier", async () => {
    const input = await fixture(); const path = join(input.root, "resources.json");
    await publishConfigFile(path, { version: 1, network: { ...resources.daemon.network, tokenSha256: "1".repeat(64) } });
    const deps = { configDir: input.configDir, boxRuntimeRoot: input.root, env: {} };
    const installed = await captureCli(["config", "bootstrap", "--from", path, "--operation-id", input.operationId, "--confirm"], deps);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout + installed.stderr).not.toContain("1".repeat(64));
    const recovered = await captureCli(["config", "bootstrap", "--recover", "--operation-id", input.operationId, "--confirm"], deps);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((parseJson(recovered.stdout) as any).data).toMatchObject({ phase: "rolled-back", restartPrevious: false });
    expect((await readInstallation(input.root))?.daemon).toBeUndefined();
  });
});
