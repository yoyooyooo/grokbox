import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { planConfigurationMigration, applyConfigurationMigration, recoverConfigurationMigration, configurationMigrationStatus } from "../src/internal/io/config-migrate.node.ts";
import { openConfigStore } from "../src/internal/io/config-store.node.ts";
import { readConfigLayout, publishConfigFile, rootConfigLayout } from "../src/internal/io/config-layout.node.ts";

const quiet = { writers: async () => [] };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "grokbox-migrate-"));
  const home = join(base, "home"); const root = join(base, "durable");
  await mkdir(join(home, "profiles", "work.v2"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "daemon"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "config.json"), '{ "version": 1, "current_profile": "work.v2" }\n', { mode: 0o600 });
  await writeFile(join(home, "profiles", "work.v2", "config.json"), JSON.stringify({ version: 1, transport: "daemon", server_url: "https://example.invalid", daemon_token_ref: "file:/synthetic/unchanged-secret" }), { mode: 0o600 });
  await writeFile(join(home, "daemon", "config.json"), JSON.stringify({ version: 1, desktop: { pruneEnabled: false, minIdleMs: 900000, keepAgentIds: [], floorAgentIds: [] } }), { mode: 0o600 });
  await writeFile(join(root, "state", "desired.json"), '{"version":1,"mode":"route"}', { mode: 0o600 });
  const models = { version: 1, models: { "example/model": { provider: "openai-chat", model: "example", endpoint: "https://example.invalid/v1", apiKeyRef: "env:SYNTHETIC_KEY", chatDialect: "minimax-inline-v1" } }, assignments: { main: null, agents: {} } };
  const modelBytes = ` ${JSON.stringify(models)}\n`;
  await writeFile(join(root, "models.json"), modelBytes, { mode: 0o600 });
  return { home, root, modelBytes, options: { configDir: home, root, role: "box" as const } };
}

describe("one-way canonical migration", () => {
  test("preview has no writes, commit preserves model bytes and refs, retires all old intent", async () => {
    const { home, root, options, modelBytes } = await fixture();
    const before = await readFile(join(home, "config.json"), "utf8");
    const plan = await planConfigurationMigration(options, quiet);
    expect(plan.canApply).toBe(true);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(before);
    expect(await configurationMigrationStatus(root)).toEqual({ state: "not-started" });
    const result = await applyConfigurationMigration(options, plan.planDigest, quiet);
    expect(result.phase).toBe("retired"); expect(result.servicesStarted).toBe(false);
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(modelBytes);
    expect(await readlink(join(home, "models.json"))).toBe(join(root, "models.json"));
    const config = (await openConfigStore(await readConfigLayout(home)).read()).document;
    expect(config.client.currentProfile).toBe("work.v2");
    expect(config.client.profiles["work.v2"]?.daemonTokenRef).toBe("file:/synthetic/unchanged-secret");
    expect(config.runtime?.desiredMode).toBe("route"); expect(config.desktop?.idleReclaim?.enabled).toBe(false);
    for (const path of [join(home, "daemon", "config.json"), join(home, "profiles", "work.v2", "config.json"), join(root, "state", "desired.json")]) expect(await readFile(path).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    const backup = join(root, "state", "config-migrations", result.operationId, "backup-home.json");
    expect(await readFile(backup, "utf8")).toBe(before);
    expect(await applyConfigurationMigration(options, plan.planDigest, quiet)).toEqual(result);
  });
  test("active writers and changed preview block before publication", async () => {
    const { home, root, options } = await fixture();
    const blocked = { writers: async () => [{ pid: 42, kind: "daemon" }] };
    const plan = await planConfigurationMigration(options, blocked);
    expect(plan.canApply).toBe(false);
    await expect(applyConfigurationMigration(options, plan.planDigest, blocked)).rejects.toThrow("blocked");
    const fresh = await planConfigurationMigration(options, quiet);
    await writeFile(join(home, "config.json"), '{"version":1,"current_profile":"default"}');
    await expect(applyConfigurationMigration(options, fresh.planDigest, quiet)).rejects.toThrow("changed");
    expect(await readFile(join(root, "config.json")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  });
  for (const phase of ["prepared", "publishing", "published", "activated"] as const) {
    test(`recovers interruption at ${phase} without second model write or authorization`, async () => {
      const { root, options, modelBytes } = await fixture();
      const plan = await planConfigurationMigration(options, quiet);
      await expect(applyConfigurationMigration(options, plan.planDigest, {
        ...quiet, checkpoint: async (current) => { if (current === phase) throw new Error("synthetic interruption"); },
      })).rejects.toThrow("synthetic interruption");
      const recovered = await recoverConfigurationMigration(root, quiet);
      expect(recovered.phase).toBe("retired");
      expect(await readFile(join(root, "models.json"), "utf8")).toBe(modelBytes);
    });
  }
  test("interrupted publication refuses an external canonical edit instead of overwriting it", async () => {
    const { root, options } = await fixture(); const plan = await planConfigurationMigration(options, quiet);
    await expect(applyConfigurationMigration(options, plan.planDigest, { ...quiet, checkpoint: async (phase) => { if (phase === "publishing") throw new Error("crash"); } })).rejects.toThrow();
    const changed = { ...defaultConfig(), desktop: { idleReclaim: { enabled: true } } };
    await publishConfigFile(join(root, "config.json"), changed);
    await expect(recoverConfigurationMigration(root, quiet)).rejects.toThrow("changed");
    expect(validateConfig(JSON.parse(await readFile(join(root, "config.json"), "utf8")))).toEqual(changed);
  });
  test("canonical versus legacy conflict requires a declared choice", async () => {
    const { root, options } = await fixture();
    await publishConfigFile(join(root, "config.json"), { ...defaultConfig(), runtime: { desiredMode: "disabled" } });
    expect((await planConfigurationMigration(options, quiet)).conflicts).toContain("runtime");
    const chosen = await planConfigurationMigration({ ...options, prefer: "canonical" }, quiet);
    expect(chosen.conflicts).toEqual([]); expect(chosen.candidate.runtime?.desiredMode).toBe("disabled");
  });
  test("client migration does not create a fake model document", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-client-migrate-"));
    await writeFile(join(root, "config.json"), '{"version":1}', { mode: 0o600 });
    const options = { configDir: root, root, role: "client" as const };
    const plan = await planConfigurationMigration(options, quiet);
    const result = await applyConfigurationMigration(options, plan.planDigest, quiet);
    expect(result.models).toBe("not-created");
    expect(await readFile(join(root, "models.json")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    expect((await openConfigStore({ ...rootConfigLayout(root), role: "client" }).read()).document.schemaVersion).toBe(3);
  });
});

for (const interruptedAt of [undefined, "published"] as const) test(`general migration preserves reasoning schema v2 bytes, interruption=${interruptedAt ?? "none"}`, async () => {
  const { home, root, options } = await fixture();
  const model = { provider: "openai-responses", model: "example", endpoint: "https://example.invalid/v1", apiKeyRef: "env:SYNTHETIC_KEY",
    contextWindowTokens: 200000, capabilities: { reasoning: { efforts: ["high", "xhigh"] } } };
  const models = { version: 2, models: { "example/model": model }, assignments: { main: null,
    agents: { "00000000-0000-4000-8000-000000000321": { modelId: "example/model", reasoning: { effort: "xhigh" } } } } };
  const modelBytes = ` ${JSON.stringify(models)}\n`;
  await writeFile(join(root, "models.json"), modelBytes, { mode: 0o600 });
  const plan = await planConfigurationMigration(options, quiet);
  expect(plan.canApply).toBe(true);
  if (interruptedAt) {
    await expect(applyConfigurationMigration(options, plan.planDigest, { ...quiet,
      checkpoint: async phase => { if (phase === interruptedAt) throw new Error("fixture interruption"); },
    })).rejects.toThrow("fixture interruption");
    expect((await recoverConfigurationMigration(root, quiet)).phase).toBe("retired");
  } else expect((await applyConfigurationMigration(options, plan.planDigest, quiet)).phase).toBe("retired");
  expect(await readFile(join(root, "models.json"), "utf8")).toBe(modelBytes);
  expect(await readlink(join(home, "models.json"))).toBe(join(root, "models.json"));
});

/** Reconstruct the old, completed config-v2 manifest shape in an owned fixture.
 * The old migrator left only the current pointer, not a per-operation manifest. */
async function completedV2Fixture() {
  const f = await fixture();
  const firstPlan = await planConfigurationMigration(f.options, quiet);
  const first = await applyConfigurationMigration(f.options, firstPlan.planDigest, quiet);
  const pointer = join(f.root, "state", "config-migration.json");
  const manifest = JSON.parse(await readFile(pointer, "utf8"));
  const v2 = { ...JSON.parse(await readFile(join(f.root, "config.json"), "utf8")), schemaVersion: 2 };
  manifest.candidateDigest = sha256Text(canonicalJson(v2));
  const directory = join(f.root, "state", "config-migrations", first.operationId);
  await publishConfigFile(join(f.root, "config.json"), v2);
  await publishConfigFile(join(directory, "candidate.json"), v2);
  await unlink(join(directory, "manifest.json"));
  const predecessorText = `${JSON.stringify(manifest)}\n`;
  await writeFile(pointer, predecessorText, { mode: 0o600 });
  return { ...f, directory, pointer, predecessorText, oldOperationId: first.operationId, v2 };
}

for (const interruption of [undefined, "prepared", "published"] as const) test(`v2 to v3 can follow an already retired migration, interruption=${interruption ?? "none"}`, async () => {
  const f = await completedV2Fixture();
  const protectedBackup = await readFile(join(f.directory, "backup-home.json"), "utf8");
  const plan = await planConfigurationMigration(f.options, quiet);
  expect(plan.canApply).toBe(true);
  expect(plan.previousMigration?.operationId).toBe(f.oldOperationId);
  expect(plan.candidate.schemaVersion).toBe(3);
  expect(await readFile(join(f.directory, "manifest.json")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  let result;
  if (interruption) {
    await expect(applyConfigurationMigration(f.options, plan.planDigest, { ...quiet, checkpoint: async phase => {
      if (phase === interruption) throw new Error("successor interruption");
    } })).rejects.toThrow("successor interruption");
    result = await recoverConfigurationMigration(f.root, quiet);
  } else result = await applyConfigurationMigration(f.options, plan.planDigest, quiet);
  expect(result.phase).toBe("retired");
  expect(result.operationId).not.toBe(f.oldOperationId);
  expect(await readFile(join(f.directory, "manifest.json"), "utf8")).toBe(f.predecessorText);
  expect(await readFile(join(f.directory, "backup-home.json"), "utf8")).toBe(protectedBackup);
  expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.modelBytes);
  expect(await readlink(join(f.home, "config.json"))).toBe(join(f.root, "config.json"));
  const current = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  expect(current).toEqual({ ...f.v2, schemaVersion: 3 });
  expect(await applyConfigurationMigration(f.options, plan.planDigest, quiet)).toEqual(result);
});

test("successor migration refuses changed predecessor or conflicting archive without replacing configuration", async () => {
  const f = await completedV2Fixture();
  const plan = await planConfigurationMigration(f.options, quiet);
  const changed = JSON.parse(f.predecessorText); changed.planDigest = "a".repeat(64);
  await publishConfigFile(f.pointer, changed);
  await expect(applyConfigurationMigration(f.options, plan.planDigest, quiet)).rejects.toThrow("changed");
  expect(JSON.parse(await readFile(join(f.root, "config.json"), "utf8"))).toEqual(f.v2);
  await writeFile(f.pointer, f.predecessorText, { mode: 0o600 });
  await publishConfigFile(join(f.directory, "manifest.json"), changed);
  await expect(applyConfigurationMigration(f.options, plan.planDigest, quiet)).rejects.toThrow("conflicts");
  expect(await readFile(f.pointer, "utf8")).toBe(f.predecessorText);
  expect(JSON.parse(await readFile(join(f.root, "config.json"), "utf8"))).toEqual(f.v2);
});

test("unfinished predecessor is a recovery requirement, not a new migration", async () => {
  const f = await completedV2Fixture();
  const unfinished = JSON.parse(f.predecessorText); unfinished.phase = "published";
  await publishConfigFile(f.pointer, unfinished);
  const plan = await planConfigurationMigration(f.options, quiet);
  expect(plan.canApply).toBe(false);
  expect(plan.conflicts).toContain("migration-recovery-required");
  await expect(applyConfigurationMigration(f.options, plan.planDigest, quiet)).rejects.toThrow("blocked");
  expect(JSON.parse(await readFile(join(f.root, "config.json"), "utf8"))).toEqual(f.v2);
});

test("general migration creates model v2 only when no model file exists", async () => {
  const { root, options } = await fixture();
  await (await import("node:fs/promises")).unlink(join(root, "models.json"));
  const plan = await planConfigurationMigration(options, quiet);
  expect((await applyConfigurationMigration(options, plan.planDigest, quiet)).models).toBe("initialized");
  expect(JSON.parse(await readFile(join(root, "models.json"), "utf8"))).toEqual({ version: 2, models: {}, assignments: { main: null, agents: {} } });
});
