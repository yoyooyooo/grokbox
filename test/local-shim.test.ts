import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cliPackage from "../package.json" with { type: "json" };

const repoRoot = join(import.meta.dir, "..");
const installer = join(repoRoot, "scripts", "install-local-shim.mjs");

async function run(argv: string[], cwd: string, env = process.env) {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  return { stdout, stderr, code };
}

describe("source-backed local global shim", () => {
  test("all explicit kernel subpaths resolve from source without requiring the checkout cwd", async () => {
    const metadata = JSON.parse(await readFile(join(repoRoot, "packages/runtime-kernel/package.json"), "utf8"));
    const paths = JSON.parse(await readFile(join(repoRoot, "tsconfig.json"), "utf8")).compilerOptions.paths;
    for (const [subpath, target] of Object.entries(metadata.exports)) {
      expect(paths[`@grokbox/runtime-kernel/${subpath.slice(2)}`]).toEqual([`./packages/runtime-kernel/${String(target).slice(2)}`]);
    }
  });
  test("installs exact executable aliases and runs the TypeScript entry from another cwd", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-test-"));
    const bin = join(fixture, "bin");
    const env = { ...process.env, GROKBOX_BUN: process.execPath, GROKBOX_SHIM_DIR: bin };
    try {
    const first = await run(["node", installer], fixture, env);
    expect(first.code, first.stderr).toBe(0);
    const second = await run(["bun", "run", installer], fixture, env);
    expect(second.code, second.stderr).toBe(0);

    const grokbox = join(bin, "grokbox");
    const gbox = join(bin, "gbox");
    const [grokboxText, gboxText] = await Promise.all([
      readFile(grokbox, "utf8"),
      readFile(gbox, "utf8"),
    ]);
    expect(grokboxText).toBe(gboxText);
    expect(grokboxText).toContain("managed by grokbox");
    expect(grokboxText).toContain('exec "$bun" run "$repo/packages/cli/src/index.ts" "$@"');
    expect((await stat(grokbox)).mode & 0o777).toBe(0o755);
    expect((await stat(gbox)).mode & 0o777).toBe(0o755);

    const [longVersion, shortVersion, help] = await Promise.all([
      run([grokbox, "--version"], fixture, env),
      run([gbox, "--version"], fixture, env),
      run([grokbox, "--help"], fixture, env),
    ]);
    expect(longVersion).toEqual({ code: 0, stdout: `${cliPackage.version}\n`, stderr: "" });
    expect(shortVersion).toEqual(longVersion);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: grokbox [options] [command]");
    } finally { await rm(fixture, { recursive: true, force: true }); }
  }, 20_000);

  test("refuses an unmanaged command before installing either alias", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-refusal-test-"));
    const bin = join(fixture, "bin");
    await mkdir(bin);
    const existing = join(bin, "grokbox");
    await writeFile(existing, "#!/bin/sh\necho unrelated\n", { mode: 0o755 });

    try {
    const result = await run(
      ["node", installer],
      fixture,
      { ...process.env, GROKBOX_SHIM_DIR: bin },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace unmanaged command");
    expect(await readFile(existing, "utf8")).toBe("#!/bin/sh\necho unrelated\n");
    await expect(stat(join(bin, "gbox"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
});
