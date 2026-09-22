import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { writeProfileFile, writeGlobalConfig } from "../packages/cli/src/config/profile.ts";
import { captureCli, parseJson } from "./helpers.ts";

async function fixture(box = true) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-config-cli-"));
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-config-cli-durable-"));
  if (box) await writeDaemonConfig(configDir, { version: 1 }, boxRuntimeRoot);
  const deps = { configDir, boxRuntimeRoot, env: {}, discoveryPath: "/dev/null", daemonSocket: join(configDir, "run", "absent.sock") };
  const run = (args: string[]) => captureCli(["config", ...args], deps);
  return { configDir, boxRuntimeRoot, deps, run };
}
function data(result: { stdout: string }): Record<string, any> { return (parseJson(result.stdout) as { data: Record<string, any> }).data; }
function errorCode(result: { stderr: string }): string { return (parseJson(result.stderr) as { error: { code: string } }).error.code; }

describe("config command uses the canonical program", () => {
  test("missing client get/schema/path are read-only and models are not synthesized", async () => {
    const f = await fixture(false);
    const get = await f.run(["get"]); expect(get.code).toBe(0); expect(data(get).value.schemaVersion).toBe(4);
    const schema = await f.run(["schema", "desktop.idleReclaim.minIdleMs"]);
    expect(schema.code).toBe(0); expect(data(schema).schema.min).toBe(600000);
    const path = await f.run(["path", "--physical"]); expect(data(path).path).toBe(join(f.configDir, "config.json"));
    expect(await stat(join(f.configDir, "config.json")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    const models = await f.run(["path", "--document", "models"]); expect(errorCode(models)).toBe("config_scope_unavailable");
    expect(await stat(join(f.configDir, "models.json")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  });
  test("scalar get/set survives restart and bad schema preserves exact bytes", async () => {
    const f = await fixture();
    const set = await f.run(["set", "desktop.idleReclaim.enabled", "true", "--confirm"]);
    expect(set.code).toBe(0); expect(data(set).commit).toBe("committed"); expect(data(set).application.state).toBe("pending");
    const get = await f.run(["get", "desktop.idleReclaim.enabled"]); expect(data(get).value).toBe(true);
    const before = await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8");
    for (const args of [
      ["set", "desktop.idleReclaim.minIdleMs", "300000"],
      ["set", "desktop.idleReclaim.enabled", "yes"],
      ["set", "desktop", '{"floorAgentIds":[]}'],
      ["set", "models", "{}"],
      ["set", "ops", '{"maintenanceGrants":{}}'],
    ]) {
      const invalid = await f.run(args); expect(invalid.code).not.toBe(0);
      expect(await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8")).toBe(before);
    }
  });
  test("preview and explicit strings work without publishing or native requests", async () => {
    const f = await fixture(); const before = await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8");
    const preview = await f.run(["set", "ops.diagnostics.mode", "--string", "automatic-bounded", "--preview"]);
    expect(preview.code).toBe(0); expect(data(preview).written).toBe(false);
    expect(await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8")).toBe(before);
    const unconfirmed = await f.run(["set", "ops.diagnostics.mode", "--string", "automatic-bounded"]);
    expect(errorCode(unconfirmed)).toBe("config_conflict");
    const requested = await f.run(["set", "ops.diagnostics.mode", "--string", "automatic-bounded", "--confirm"]);
    expect(requested.code).toBe(0);
    const read = await f.run(["get", "ops", "--effective"]);
    expect(data(read).executionAuthorized).toBe(false); expect(data(read).application).toBe("not-observed");
  });
  test("all array writes need replacement, confirmation and expected revision", async () => {
    const f = await fixture();
    const read = await f.run(["get"]); const revision = data(read).configRevision;
    const payload = '["00000000-0000-4000-8000-000000000123"]';
    expect((await f.run(["set", "desktop.keepAgentIds", payload, "--confirm"])).code).not.toBe(0);
    const written = await f.run(["set", "desktop.keepAgentIds", payload, "--replace", "--confirm", "--expect-revision", revision]);
    expect(written.code).toBe(0);
    const stale = await f.run(["set", "desktop.keepAgentIds", "[]", "--replace", "--confirm", "--expect-revision", revision]);
    expect(errorCode(stale)).toBe("config_conflict");
    const indexed = await f.run(["set", "desktop.keepAgentIds.0", '"x"']);
    expect(errorCode(indexed)).toBe("config_path_invalid");
  });
  test("JSON Pointer edits a dotted Profile name without creating a nested profile", async () => {
    const f = await fixture(false);
    await writeProfileFile(f.configDir, "work.v2", { version: 1, transport: "auto" });
    const result = await f.run(["set", "/client/profiles/work.v2/transport", "--string", "local"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(await readFile(join(f.configDir, "config.json"), "utf8"));
    expect(document.client.profiles["work.v2"].transport).toBe("local");
    expect(document.client.profiles.work).toBeUndefined();
  });
  test("selected remote never causes a silent write to the initiating machine", async () => {
    const f = await fixture();
    await writeProfileFile(f.configDir, "remote", { version: 1, transport: "daemon", server_url: "https://example.invalid", daemon_token_ref: "env:SYNTHETIC" });
    await writeGlobalConfig(f.configDir, { version: 1, current_profile: "remote" });
    const before = await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8");
    const ambiguous = await f.run(["set", "desktop.idleReclaim.enabled", "true"]);
    expect(errorCode(ambiguous)).toBe("config_scope_required");
    const target = await f.run(["set", "desktop.idleReclaim.enabled", "true", "--scope", "target"]);
    expect(errorCode(target)).toBe("config_scope_unavailable");
    expect(await readFile(join(f.boxRuntimeRoot, "config.json"), "utf8")).toBe(before);
    expect((await f.run(["set", "desktop.idleReclaim.enabled", "true", "--confirm", "--scope", "local"])).code).toBe(0);
  });
  test("bad installed JSON cannot block path/schema/file validation or migration preview", async () => {
    const f = await fixture(false);
    await writeFile(join(f.configDir, "config.json"), "{broken", { mode: 0o600 });
    expect((await f.run(["path", "--physical"])).code).toBe(0);
    expect((await f.run(["schema"])).code).toBe(0);
    const file = join(f.configDir, "candidate.json"); await writeFile(file, JSON.stringify(defaultConfig()), { mode: 0o600 });
    expect((await f.run(["validate", "--file", file])).code).toBe(0);
    const invalid = await f.run(["get"]); expect(errorCode(invalid)).toBe("config_invalid");
    await writeFile(join(f.configDir, "config.json"), '{"version":1}', { mode: 0o600 });
    const preview = await f.run(["migrate", "--preview", "--role", "client"]);
    expect(preview.code).toBe(0); expect(data(preview).canApply).toBe(true);
    expect((await f.run(["get"])).code).not.toBe(0);
    const applied = await f.run(["migrate", "--apply", "--role", "client", "--plan-digest", data(preview).planDigest, "--confirm"]);
    expect(applied.code).toBe(0); expect(data(applied).phase).toBe("retired");
    expect((await f.run(["get"])).code).toBe(0);
  });
  test("file values reject duplicate members and never echo secrets", async () => {
    const f = await fixture(); const file = join(f.configDir, "bad.json");
    await writeFile(file, '{"mode":"on-request","mode":"SECRET_SENTINEL"}', { mode: 0o600 });
    const result = await f.run(["set", "ops.diagnostics", "--value-file", file]);
    expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain("SECRET_SENTINEL");
  });
  test("portable export omits real target identities and secret reference locations", async () => {
    const f = await fixture();
    await writeProfileFile(f.configDir, "private", { version: 1, transport: "daemon", server_url: "https://example.invalid", daemon_token_ref: "file:/private/SENTINEL" });
    const get = await f.run(["get"]); expect(get.stdout).not.toContain("/private/SENTINEL");
    const exported = await f.run(["export", "--portable"]);
    expect(exported.code).toBe(0); expect(exported.stdout).not.toContain("/private/SENTINEL");
    expect(data(exported).bindingsIncluded).toBe(false); expect(data(exported).grantsIncluded).toBe(false);
  });
});
