import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

async function run(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

(process.platform === "linux" && process.arch === "x64" ? test : test.skip)("an exited last thread has no fd table while its zombie remains in the census", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await run("python3", ["-I", "-S", join(repo, "packages/box-runtime/test/fixtures/retirement-fd-exit.py"),
    join(repo, "packages/box-runtime/src/internal/process/helpers/retirement-observer.py")]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ liveOwnerChecked: true, zombieStillInCensus: true, lockReleasedBeforeReap: true, ownedJoined: true, signals: 0 });
}, 15000);

(process.platform === "linux" && process.arch === "x64" ? test : test.skip)("socket credential origin may exit while an owned socket remains live", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await run("python3", ["-I", "-S", join(repo, "packages/box-runtime/test/fixtures/retirement-peer-origin.py"),
    join(repo, "packages/box-runtime/src/internal/process/helpers/retirement-observer.py")]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ creatorAbsent: true, liveSocketsObserved: true, ownedJoined: true, signals: 0 });
}, 15000);

(process.platform === "linux" && process.arch === "x64" ? test : test.skip)("owned Linux namespace: same-PID exec, real memory/FD proof, stopped modeld and existing recovery owner", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url)), root = await mkdtemp(join(tmpdir(), "current-restoration-node-"));
  const outfile = join(root, "fixture.mjs"), executable = join(root, "before-exec");
  const compiled = await run("cc", ["-O2", "-Wall", "-Wextra", join(repo, "packages/box-runtime/test/fixtures/retirement-exec.c"), "-o", executable]);
  expect(compiled.code, compiled.stderr).toBe(0);
  await build({ absWorkingDir: repo, entryPoints: ["packages/box-runtime/test/fixtures/current-restoration.node.ts"], outfile,
    bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent", external: ["classic-level", "sqlite3"],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  await copyFile(join(repo, "packages/box-runtime/src/internal/process/helpers/retirement-observer.py"), join(root, "retirement-observer.py"));
  const result = await run("unshare", ["--map-current-user", "--pid", "--fork", "--mount", "--mount-proc", "node", outfile, join(root, "owned"), executable]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ serviceStartBlockedThroughCompletion: true, serviceStartAfterRelease: true, samePidExec: true, oldImageRejected: true, inheritedLockRejected: true, retiredResourcesAccepted: true,
    originalBytesPreserved: true, stoppedModeldAbsent: true, privateInputs: false, signals: 0 });
}, 15000);
