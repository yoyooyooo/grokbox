import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ensurePackedCli } from "./packed-cli-fixture.ts";

/** Real Node/public parser and the installed read-only manager probe. Never
 * confirm registration, start a service, alter the caller HOME or need Gateway. */
test("packed runtime service inspection works with broken Profile configuration and creates nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-services-packed-")), root = join(dir, "root"), run = join(dir, "run"), home = join(dir, "home");
  try {
    for (const p of [root, run, home]) await mkdir(p, { mode: 0o700 });
    await writeFile(join(root, "config.json"), "{broken PRIVATE_CONFIG", { mode: 0o600 });
    const child = spawn("node", [ensurePackedCli(), "runtime", "services", "status", "--run-root", run, "--json"], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: home, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root,
        GROKBOX_RUN_ROOT: run, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"], timeout: 12000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(code, stderr).toBe(0); expect(stdout + stderr).not.toContain("PRIVATE_CONFIG");
    expect(JSON.parse(stdout).data).toMatchObject({ phase: "not_installed", createsServices: false, executionQualified: false });
    expect(await readdir(home)).toEqual([]); expect(await readdir(run)).toEqual([]); expect(await readdir(root)).toEqual(["config.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);
