import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Node: delayed Gateway, postcompile exit, independent guardian expiry and sanitized child evidence", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "grokbox-adopt-node-")), outfile = join(root, "fixture.mjs");
  await build({ absWorkingDir: repo, entryPoints: ["packages/box-runtime/test/fixtures/controller-adoption-failure.node.ts"], outfile,
    bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent" });
  for (const name of ["guardian-child.cjs", "injector-hold.cjs", "grokbox-temp-supervisor.cjs"]) {
    await copyFile(join(repo, "packages/box-runtime/src/internal/process/helpers", name), join(root, name));
  }
  const child = spawn("node", [outfile, join(root, "owned")], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ cases: ["delayed-gateway", "postcompile-exit", "guardian-expiry", "injector-death"], isolated: true, rawOutputCaptured: false });
}, 15000);
