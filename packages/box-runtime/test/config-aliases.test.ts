import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { previewConfigurationAliases, repairConfigurationAliases } from "../src/internal/io/config-aliases.node.ts";
import { publishConfigFile, publishLayoutAliases, readConfigLayout } from "../src/internal/io/config-layout.node.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-alias-repair-"));
  const root = join(dir, "durable"), home = join(dir, "config"), installationId = randomUUID();
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, role: "box", root, installationId });
  await publishConfigFile(join(root, "config.json"), defaultConfig());
  await publishConfigFile(join(root, "models.json"), { version: 1, models: {}, assignments: { main: null, agents: {} } });
  await publishLayoutAliases(home, root, installationId);
  return { home, root };
}

describe("explicit managed alias repair", () => {
  test("preserves malformed detached editor bytes, never merges them into canonical models", async () => {
    const { home, root } = await fixture(); const alias = join(home, "models.json");
    const canonical = await readFile(join(root, "models.json"), "utf8");
    await unlink(alias); await writeFile(alias, "uncommitted editor text — not JSON", { mode: 0o600 });
    await expect(readConfigLayout(home, root)).rejects.toThrow("alias");
    const preview = await previewConfigurationAliases(home, root);
    expect(preview).toMatchObject({ needsRepair: true, mutated: false, changes: ["models.json"] });
    expect(await readFile(alias, "utf8")).toBe("uncommitted editor text — not JSON");
    const receipt = await repairConfigurationAliases(home, preview.planDigest, root);
    expect(receipt).toMatchObject({ repaired: true, canonicalPreserved: true, detachedFilesPreserved: true });
    expect(await readlink(alias)).toBe(join(root, "models.json"));
    expect(await readFile(join(home, `.grokbox-models.json-${preview.planDigest}.detached`), "utf8")).toBe("uncommitted editor text — not JSON");
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(canonical);
    expect((await readConfigLayout(home, root)).role).toBe("box");
    expect(await repairConfigurationAliases(home, preview.planDigest, root)).toEqual(receipt);
  });
  test("source changes after preview block repair without touching either file", async () => {
    const { home, root } = await fixture(); const alias = join(home, "config.json");
    await unlink(alias); await writeFile(alias, "first draft", { mode: 0o600 });
    const preview = await previewConfigurationAliases(home, root);
    await writeFile(alias, "later user draft");
    await expect(repairConfigurationAliases(home, preview.planDigest, root)).rejects.toThrow("changed");
    expect(await readFile(alias, "utf8")).toBe("later user draft");
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual(defaultConfig());
  });
  test("missing aliases can be restored without inventing configuration or retargeting the installation", async () => {
    const { home, root } = await fixture(); await unlink(join(home, "config.json"));
    const preview = await previewConfigurationAliases(home, root);
    await expect(repairConfigurationAliases(home, preview.planDigest, join(root, "other"))).rejects.toThrow("changed");
    await repairConfigurationAliases(home, preview.planDigest, root);
    expect(await readlink(join(home, "config.json"))).toBe(join(root, "config.json"));
  });
  test("interrupted retirement resumes the same repair instead of moving the detached file twice", async () => {
    const { home, root } = await fixture(); const alias = join(home, "config.json");
    await unlink(alias); await writeFile(alias, "draft to retain", { mode: 0o600 });
    const preview = await previewConfigurationAliases(home, root);
    await repairConfigurationAliases(home, preview.planDigest, root);
    const path = join(root, "state", "config-alias-repairs", `${preview.planDigest}.json`);
    const record = JSON.parse(await readFile(path, "utf8")); record.phase = "prepared";
    await publishConfigFile(path, record); await unlink(alias);
    await repairConfigurationAliases(home, preview.planDigest, root);
    expect(await readlink(alias)).toBe(join(root, "config.json"));
    expect(await readFile(join(home, `.grokbox-config.json-${preview.planDigest}.detached`), "utf8")).toBe("draft to retain");
  });
  test("already repaired receipts cannot erase a new detached user edit", async () => {
    const { home, root } = await fixture(); const alias = join(home, "config.json");
    await unlink(alias); await writeFile(alias, "draft", { mode: 0o600 });
    const preview = await previewConfigurationAliases(home, root);
    await repairConfigurationAliases(home, preview.planDigest, root);
    await unlink(alias); await writeFile(alias, "second draft", { mode: 0o600 });
    await expect(repairConfigurationAliases(home, preview.planDigest, root)).rejects.toThrow("changed");
    expect(await readFile(alias, "utf8")).toBe("second draft");
  });
});
