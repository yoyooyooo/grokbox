import { expect, test } from "bun:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("packed Node recovery uses real disk commits and survives forced death at claimed/waiting/terminal boundaries", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url)), dir = await mkdtemp(join(tmpdir(), "recovery-node-"));
  const levelEntry = createRequire(join(repo, "package.json")).resolve("classic-level"), outfile = join(dir, "probe.mjs");
  try {
    await build({ absWorkingDir: repo, entryPoints: ["packages/box-runtime/test/fixtures/provider-recovery-node.ts"], outfile,
      bundle: true, platform: "node", target: "node20", format: "esm", logLevel: "silent",
      plugins: [{ name: "installed-native-store", setup(build) { build.onResolve({ filter: /^classic-level$/ }, () => ({ path: levelEntry, external: true })); } }],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const env = { PATH: process.env.PATH, HOME: dir };
    const good = spawnSync("node", [outfile, "run", join(dir, "good")], { env, encoding: "utf8", timeout: 10000 });
    expect(good.status, good.stderr).toBe(0); expect(JSON.parse(good.stdout)).toMatchObject({ calls: 2, phase: "succeeded", networkCalls: 0 });
    for (const boundary of ["running", "waiting", "succeeded"]) {
      const root = join(dir, boundary), child = spawn("node", [outfile, "crash", root, boundary], { env, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      try {
        await new Promise<void>((resolve, reject) => {
          let text = "";
          const timer = setTimeout(() => reject(Error("fixture commit barrier timed out")), 5000);
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", () => { clearTimeout(timer); reject(Error("fixture exited before commit barrier")); });
          child.stdout.on("data", data => { text += String(data); if (text.includes("\n")) { clearTimeout(timer); const row = JSON.parse(text.split("\n")[0]!); if (row.committed && row.phase === boundary) resolve(); else reject(Error("wrong commit barrier")); } });
        });
        child.kill("SIGKILL"); await exited;
        const check = spawnSync("node", [outfile, "inspect", root, boundary], { env, encoding: "utf8", timeout: 10000 });
        expect(check.status, check.stderr).toBe(0); expect(JSON.parse(check.stdout)).toMatchObject({ recovered: true, phase: boundary, httpCalls: 0, sameEpochRefused: true, newEpochRetired: true, autoResumed: false });
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);
