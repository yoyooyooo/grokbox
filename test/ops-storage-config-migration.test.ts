import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, configurationRevisions } from "../packages/runtime-kernel/src/config.ts";
import { planConfigurationMigration, applyConfigurationMigration, recoverConfigurationMigration, migrationPreview } from "../packages/box-runtime/src/internal/io/config-migrate.node.ts";
import { openConfigStore } from "../packages/box-runtime/src/internal/io/config-store.node.ts";
import { rootConfigLayout } from "../packages/box-runtime/src/internal/io/config-layout.node.ts";
import { readStorageConfiguration } from "../packages/box-runtime/src/internal/io/storage-configuration.node.ts";
import { captureCli, parseJson } from "./helpers.ts";

const quiet = { writers: async () => [] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ops-storage-migrate-")), root = join(directory, "durable"), home = join(directory, "home");
  await mkdir(root, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const original = { ...defaultConfig(), schemaVersion: 3,
    runtime: { desiredMode: "disabled" as const, context: { windowTokens: 64000 } },
    ops: { enabled: false, notifications: { mode: "off", maxAutomaticWakeupsPerDay: 0, criticalReservePerDay: 0 },
      targets: { default: { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", dataPolicy: "safe-summary" } },
      support: { offerIssue: true, submit: "preauthorized-summary", credentialRef: "env:PRIVATE_ISSUE_REFERENCE", repository: "example/project" } } };
  const before = JSON.stringify(original) + "\n", models = '{"version":2, "models":{}, "assignments":{"main":null,"agents":{}}}\n';
  await writeFile(join(root, "config.json"), before, { mode: 0o600 }); await writeFile(join(root, "models.json"), models, { mode: 0o600 });
  const options = { configDir: home, root, role: "box" as const };
  const deps = { configDir: home, boxRuntimeRoot: root, env: { GROKBOX_BOX_RUNTIME_ROOT: root, GROKBOX_RUN_ROOT: join(directory, "run") }, transport: "local" as const, stdinIsTTY: true };
  return { directory, root, home, before, models, original, options, deps, close: () => rm(directory, { recursive: true, force: true }) };
}

for (const interruption of [undefined, "prepared", "published"] as const) test(`v3 storage cutover preserves exact models and old off settings; interruption=${interruption ?? "none"}`, async () => {
  const f = await fixture(); try {
    const beforeNames = await readdir(f.root);
    await expect(openConfigStore(rootConfigLayout(f.root)).read()).rejects.toMatchObject({ code: "config_migration_required" });
    const plan = await planConfigurationMigration(f.options, quiet), preview = migrationPreview(plan);
    expect(plan.canApply).toBe(true); expect(preview.targetSchemaVersion).toBe(4);
    expect(preview.support).toMatchObject({ disposition: "retired", offerIssue: false, automaticPublishing: false, credentialsCreated: false, bindingsCreated: false });
    expect(preview.storage).toMatchObject({ garbageCollectionDuringMigration: false, installationBudgetEnforced: false });
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_ISSUE_REFERENCE"); expect(await readdir(f.root)).toEqual(beforeNames);
    let receipt;
    if (interruption) {
      await expect(applyConfigurationMigration(f.options, plan.planDigest, { ...quiet, checkpoint: async phase => {
        if (phase === interruption) throw Error("owned_storage_migration_interruption");
      } })).rejects.toThrow("owned_storage_migration_interruption");
      receipt = await recoverConfigurationMigration(f.root, quiet);
    } else receipt = await applyConfigurationMigration(f.options, plan.planDigest, quiet);
    expect(receipt.phase).toBe("retired");
    const { support: _, ...ops } = f.original.ops;
    expect((await openConfigStore(rootConfigLayout(f.root)).read()).document).toEqual({ ...f.original, schemaVersion: 4, ops });
    expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.models);
    expect(await readFile(join(f.root, "state/config-migrations", receipt.operationId, "backup-canonical.json"), "utf8")).toBe(f.before);
    expect(await readlink(join(f.home, "config.json"))).toBe(join(f.root, "config.json"));
    expect(await readdir(f.root)).not.toContain("observability");
    for (const name of ["ops-grants.json", "ops-bindings.json", "config-consumers"]) expect(await readdir(join(f.root, "state"))).not.toContain(name);
  } finally { await f.close(); }
});

test("invalid legacy support is not silently discarded and a changed plan cannot overwrite newer choices", async () => {
  const f = await fixture(); try {
    const invalid = { ...f.original, ops: { ...f.original.ops, support: { ...f.original.ops.support, sendTranscript: true } } };
    await writeFile(join(f.root, "config.json"), JSON.stringify(invalid), { mode: 0o600 });
    await expect(planConfigurationMigration(f.options, quiet)).rejects.toBeDefined();
    expect(await readdir(f.root)).toEqual(["config.json", "models.json"]);
    await writeFile(join(f.root, "config.json"), f.before, { mode: 0o600 });
    const plan = await planConfigurationMigration(f.options, quiet);
    const newer = { ...f.original, ops: { ...f.original.ops, notifications: { ...f.original.ops.notifications, maxAutomaticWakeupsPerDay: 1 } } };
    const newerBytes = JSON.stringify(newer);
    await writeFile(join(f.root, "config.json"), newerBytes, { mode: 0o600 });
    await expect(applyConfigurationMigration(f.options, plan.planDigest, quiet)).rejects.toBeDefined();
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(newerBytes);
  } finally { await f.close(); }
});

test("storage status stays usable during schema migration without a Profile read or repair", async () => {
  const f = await fixture(); try {
    // Both the client-facing file and canonical file deliberately have old schema.
    await writeFile(join(f.home, "config.json"), f.before, { mode: 0o600 });
    const before = await readFile(join(f.root, "config.json"));
    const status = await captureCli(["runtime", "storage", "status", "--json"], f.deps);
    expect(status.code, status.stderr).toBe(0);
    expect(parseJson(status.stdout)).toMatchObject({ data: { state: "not_initialized", storageIntent: { state: "unavailable" }, installationBudgetEnforced: false } });
    expect(await readFile(join(f.root, "config.json"))).toEqual(before);
    expect(await readdir(f.root)).toEqual(["config.json", "models.json"]);
    const denied = await captureCli(["runtime", "monitor", "init", "--confirm", "--json"], f.deps);
    expect(denied.code).not.toBe(0); expect(denied.stderr).toContain("config_migration_required");
    expect(await readdir(f.root)).toEqual(["config.json", "models.json"]);
  } finally { await f.close(); }
});

test("actual config CLI separates storage intent, confirmation and pending adoption without starting maintenance", async () => {
  const f = await fixture(); try {
    const plan = await planConfigurationMigration(f.options, quiet); await applyConfigurationMigration(f.options, plan.planDigest, quiet);
    const run = (args: string[]) => captureCli(["config", ...args, "--json"], f.deps);
    const initial = await openConfigStore(rootConfigLayout(f.root)).read(), revisions = configurationRevisions(initial.document);
    const effective = await run(["get", "storage", "--effective"]);
    expect(effective.code, effective.stderr).toBe(0); expect(parseJson(effective.stdout)).toMatchObject({ data: { executionAuthorized: false, application: "not-observed", value: { policyRevision: 1 } } });
    const before = await readFile(join(f.root, "config.json"));
    const denied = await run(["set", "storage.diagnostics.detailDays", "2"]); expect(denied.code).not.toBe(0);
    expect(await readFile(join(f.root, "config.json"))).toEqual(before);
    const preview = await run(["set", "storage.diagnostics.detailDays", "2", "--preview"]); expect(preview.code, preview.stderr).toBe(0);
    expect(parseJson(preview.stdout)).toMatchObject({ data: { written: false } }); expect(await readFile(join(f.root, "config.json"))).toEqual(before);
    const written = await run(["set", "storage.diagnostics.detailDays", "2", "--confirm", "--wait-applied", "--timeout-ms", "20"]);
    expect(written.code).toBe(80);
    const after = await openConfigStore(rootConfigLayout(f.root)).read();
    expect(after.document.storage?.diagnostics?.detailDays).toBe(2);
    expect(configurationRevisions(after.document).runtime).toBe(revisions.runtime); expect(configurationRevisions(after.document).ops).toBe(revisions.ops);
    expect((await readStorageConfiguration(f.root)).monitor.retentionMs).toBe(2 * 86400000);
    expect(await readdir(f.root)).not.toContain("observability"); expect(await readdir(join(f.root, "state"))).not.toContain("config-consumers");
    expect((await run(["get", "ops.support", "--effective"])).code).not.toBe(0);
    expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.models);
  } finally { await f.close(); }
});
