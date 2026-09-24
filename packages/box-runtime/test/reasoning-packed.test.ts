import { beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const safeEnv = (home: string) => ({ PATH: process.env.PATH ?? "", HOME: home, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" });
// The owned build has its own 60-second subprocess bound. Keep it out of the
// five-second command scenario, matching the other packed CLI fixtures.
beforeAll(() => { ensurePackedCli(); }, 90000);
test("Node bundle executes both qualified reasoning backends with synthetic HTTP only", async () => {
  const home = await mkdtemp(join(tmpdir(), "reasoning-node-")), outfile = join(home, "proof.mjs");
  try {
    await build({ absWorkingDir: root, entryPoints: ["packages/box-runtime/test/fixtures/reasoning-backend-node.ts"], outfile,
      bundle: true, platform: "node", target: "node20", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const run = spawnSync("node", [outfile], { env: safeEnv(home), encoding: "utf8", timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const proof = JSON.parse(run.stdout);
    expect(proof.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(proof.observed).toEqual([{ api: "chat", calls: 1, effort: "xhigh", reasoningTokens: 12 }, { api: "responses", calls: 1, effort: "xhigh", reasoningTokens: 12 }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("actual packed Node CLI rejects retired model documents and has no migration or query fallback", async () => {
  const cli = ensurePackedCli(), home = await mkdtemp(join(tmpdir(), "reasoning-packed-cli-"));
  const durable = join(home, "durable"), path = join(durable, "models.json");
  const agent = "11111111-1111-4111-8111-111111111111";
  try {
    await mkdir(durable, { mode: 0o700 });
    const run = (...args: string[]) => spawnSync("node", [cli, ...args], { env: { ...safeEnv(home), GROKBOX_BOX_RUNTIME_ROOT: durable,
      GROKBOX_RUN_ROOT: join(home, "run"), GROKBOX_CONFIG_DIR: join(home, "config") }, encoding: "utf8", timeout: 30000 });
    for (const version of [1, 2]) {
      const original = JSON.stringify({ version, models: {}, assignments: { main: null, agents: { [agent]: version === 1 ? "stub/echo" : { modelId: "stub/echo" } } } });
      await writeFile(path, original, { mode: 0o600 });
      expect(run("models", "migrate").status).toBe(2);
      expect(run("models", "migrate", "--confirm").status).toBe(2);
      const refused = run("models", "check");
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("current version 3");
      expect(await readFile(path, "utf8")).toBe(original);
    }
    // The test owns this new document. The application never converted old bytes.
    const saved = JSON.stringify({ version: 3, models: {}, assignments: { main: null, agents: { [agent]: { modelId: "stub/echo" } } } });
    await writeFile(path, saved, { mode: 0o600 });
    const checked = run("models", "check"); expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).data.assignments.agents[agent]).toEqual({ modelId: "stub/echo" });
    const shown = run("bot", "model", "get", agent); expect(shown.status).toBe(7);
    expect(JSON.parse(shown.stdout)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await readFile(path, "utf8")).toBe(saved);
  } finally { await rm(home, { recursive: true, force: true }); }
});
