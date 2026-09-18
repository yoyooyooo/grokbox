import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, lstat, readlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../dist/index.js");
function cli(home: string, root: string, args: string[]) {
  const result = spawnSync("node", [entry, ...args, "--json"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C.UTF-8", GROKBOX_CONFIG_DIR: join(home, ".grokbox"),
      GROKBOX_BOX_RUNTIME_ROOT: root, GROKBOX_RUN_ROOT: join(home, "isolated-run") },
    cwd: home, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}
function data(result: ReturnType<typeof cli>): any {
  expect(result.error).toBeUndefined(); expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout).data;
}

describe("packaged Node unified configuration", () => {
  test("fresh bootstrap, aliases, commits, redaction and source-independent schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokbox-config-packed-"));
    const root = join(home, "durable"), configDir = join(home, ".grokbox");
    expect(data(cli(home, root, ["config", "get"])).value.schemaVersion).toBe(4);
    expect(await lstat(configDir).catch(() => null)).toBeNull();
    const resources = join(home, "resources.json");
    await writeFile(resources, JSON.stringify({ version: 1, desktop: { pruneEnabled: false, floorAgentIds: ["00000000-0000-4000-8000-000000000001"] } }), { mode: 0o600 });
    expect(data(cli(home, root, ["config", "bootstrap", "--from", resources, "--operation-id", "packed-install", "--confirm"])).installed).toBe(true);
    expect(await readlink(join(configDir, "config.json"))).toBe(join(root, "config.json"));
    expect(await readlink(join(configDir, "models.json"))).toBe(join(root, "models.json"));
    const models = await readFile(join(root, "models.json"), "utf8");
    const saved = data(cli(home, root, ["config", "set", "desktop.idleReclaim.minIdleMs", "900000"]));
    expect(saved).toMatchObject({ commit: "committed", application: { state: "pending" } });
    expect(data(cli(home, root, ["config", "get", "desktop.idleReclaim.minIdleMs"])).value).toBe(900000);
    const before = await readFile(join(root, "config.json"), "utf8");
    expect(cli(home, root, ["config", "set", "desktop.floorAgentIds", "[]"]).code).not.toBe(0);
    expect(cli(home, root, ["config", "set", "desktop.idleReclaim.minIdleMs", "1"]).code).not.toBe(0);
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(models);
    const schema = data(cli(home, root, ["config", "schema", "desktop.idleReclaim.minIdleMs"]));
    expect(schema.schema).toMatchObject({ type: "integer", min: 600000 });
    const pending = cli(home, root, ["config", "set", "desktop.idleReclaim.enabled", "true", "--wait-applied", "--timeout-ms", "20"]);
    expect(pending.code).toBe(80);
    expect(JSON.parse(pending.stderr).error.context.commit).toBe("committed");
    expect(data(cli(home, root, ["config", "get", "desktop.idleReclaim.enabled"])).value).toBe(true);
  });

  test("alias repair remains available when ordinary configuration commands refuse a detached file", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokbox-config-packed-alias-"));
    const root = join(home, "durable"), dir = join(home, ".grokbox");
    const resources = join(home, "resources.json");
    await writeFile(resources, '{"version":1}', { mode: 0o600 });
    data(cli(home, root, ["config", "bootstrap", "--from", resources, "--operation-id", "alias-install", "--confirm"]));
    const canonical = await readFile(join(root, "models.json"), "utf8");
    await unlink(join(dir, "models.json"));
    await writeFile(join(dir, "models.json"), "unsaved editor fragment", { mode: 0o600 });
    expect(cli(home, root, ["config", "get"]).code).toBe(78);
    const preview = data(cli(home, root, ["config", "aliases", "--preview"]));
    expect(preview).toMatchObject({ mutated: false, detachedFiles: ["models.json"] });
    expect(cli(home, root, ["config", "aliases", "--apply", "--plan-digest", preview.planDigest]).code).not.toBe(0);
    const repaired = data(cli(home, root, ["config", "aliases", "--scope", "local", "--apply", "--plan-digest", preview.planDigest, "--confirm"]));
    expect(repaired).toMatchObject({ repaired: true, canonicalPreserved: true, servicesStarted: false });
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(canonical);
    expect(await readFile(join(dir, `.grokbox-models.json-${preview.planDigest}.detached`), "utf8")).toBe("unsaved editor fragment");
    expect(data(cli(home, root, ["config", "get"])).value.schemaVersion).toBe(4);
  });

  test("explicit migration retires legacy files, preserves exact models and remains cold-readable", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokbox-config-packed-migrate-"));
    const root = join(home, "durable"), dir = join(home, ".grokbox");
    await mkdir(join(dir, "daemon"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "config.json"), '{"version":1,"current_profile":"default"}', { mode: 0o600 });
    await writeFile(join(dir, "daemon", "config.json"), '{"version":1,"desktop":{"pruneEnabled":false,"minIdleMs":900000}}', { mode: 0o600 });
    await writeFile(join(root, "state", "desired.json"), '{"version":1,"mode":"disabled"}', { mode: 0o600 });
    const modelBytes = '{"version":1, "models":{}, "assignments":{"main":null,"agents":{}}}\n';
    await writeFile(join(root, "models.json"), modelBytes, { mode: 0o600 });
    expect(cli(home, root, ["config", "get"]).code).toBe(79);
    const args = ["config", "migrate", "--role", "box", "--durable-root", root];
    const preview = data(cli(home, root, [...args, "--preview"]));
    expect(preview.blockedWriters).toEqual([]);
    expect(preview.canApply).toBe(true);
    data(cli(home, root, [...args, "--apply", "--plan-digest", preview.planDigest, "--confirm"]));
    expect(data(cli(home, root, ["config", "get", "desktop.idleReclaim.minIdleMs"])).value).toBe(900000);
    expect(data(cli(home, root, ["config", "get", "runtime.desiredMode"])).value).toBe("disabled");
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(modelBytes);
    expect(await lstat(join(dir, "daemon", "config.json")).catch(() => null)).toBeNull();
    expect(await lstat(join(root, "state", "desired.json")).catch(() => null)).toBeNull();
    expect((await lstat(join(dir, "config.json"))).isSymbolicLink()).toBe(true);
    expect(data(cli(home, root, ["config", "migrate", "--status"])).state).toBe("retired");
  });
});
