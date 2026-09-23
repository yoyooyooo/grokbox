import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cliPackage from "../package.json" with { type: "json" };
import { defaultConfig } from "@grokbox/runtime-kernel/config";

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
    const second = await run(["bun", "run", "--cwd", repoRoot, installer], fixture, env);
    expect(second.code, second.stderr).toBe(0);

    const grokbox = join(bin, "grokbox");
    const gbox = join(bin, "gbox");
    const [grokboxText, gboxText] = await Promise.all([
      readFile(grokbox, "utf8"),
      readFile(gbox, "utf8"),
    ]);
    expect(grokboxText).toBe(gboxText);
    expect(grokboxText).toContain("managed by grokbox");
    expect(grokboxText).toContain("pwd -P");
    expect(grokboxText).not.toContain('caller_cwd="$PWD"');
    expect(grokboxText).toContain('exec "$bun" run --no-env-file --cwd "$repo" "$repo/scripts/source-cli.ts" "$caller_cwd" "$@"');
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

for (const mode of ["nonzero", "wrong-version", "overflow", "timeout"] as const) {
  test(`installer keeps bounded, secret-free probe diagnostics: ${mode}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-diagnostic-"));
    const bin = join(fixture, "bin"), fake = join(fixture, "synthetic-bun");
    const secret = "PRIVATE_CHILD_OUTPUT_NOT_FOR_DIAGNOSTICS";
    const body = mode === "timeout" ? "exec sleep 30" : mode === "nonzero" ? `printf '%s\n' '${secret}' >&2; exit 9`
      : mode === "overflow" ? `exec node -e 'process.stdout.write("${secret}".repeat(4000))'` : `printf '%s\n' '${secret}'`;
    try {
      await writeFile(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const result = await run(["node", installer], fixture, { ...process.env, GROKBOX_SHIM_DIR: bin, GROKBOX_BUN: fake });
      expect(result.code).not.toBe(0); expect(result.stderr).toContain("Installed shim verification failed:");
      expect(result.stderr).not.toContain(secret);
      const match = /^Error: Installed shim verification failed: (\{[^\n]+\})$/m.exec(result.stderr);
      expect(match).not.toBeNull();
      const detail = JSON.parse(match![1]!);
      expect(detail.phase).toBe("installed-shim-version"); expect(detail.timeoutMs).toBe(10000);
      expect(detail.reason).toBe(mode === "timeout" ? "timeout" : mode === "overflow" ? "spawn-error" : mode === "nonzero" ? "nonzero-exit" : "version-mismatch");
      if (mode === "nonzero") expect(detail.status).toBe(9);
      if (mode === "timeout") expect(detail.errorCode).toBe("ETIMEDOUT");
      if (mode === "overflow") expect(detail.errorCode).toBe("ENOBUFS");
      expect(Object.keys(detail).sort()).toEqual(["alias", "errorCode", "phase", "reason", "signal", "status", "stderrBytes", "stdoutBytes", "timeoutMs"].sort());
    } finally { await rm(fixture, { recursive: true, force: true }); }
  }, 20000);
}


test("source shim restores relative paths and keeps invocation environment explicit", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-cwd-"));
  const caller = join(fixture, "caller with 'quote\n"), bin = join(fixture, "bin");
  await mkdir(caller);
  const env = { ...process.env, HOME: fixture, GROKBOX_BUN: process.execPath, GROKBOX_SHIM_DIR: bin,
    GROKBOX_CONFIG_DIR: join(fixture, "exported-config"), GROKBOX_BOX_RUNTIME_ROOT: join(fixture, "exported-root"), PWD: "/not-the-callers-directory" };
  try {
    await writeFile(join(caller, "relative config.json"), JSON.stringify(defaultConfig()), { mode: 0o600 });
    await writeFile(join(caller, "duplicate field.json"), JSON.stringify({ kind: "bot" }), { mode: 0o600 });
    await writeFile(join(caller, ".env"), "GROKBOX_CONFIG_DIR=/invalid-implicit-dotenv-root\n", { mode: 0o600 });
    const installed = await run(["node", installer], caller, env);
    expect(installed.code, installed.stderr).toBe(0);
    for (const alias of ["grokbox", "gbox"]) {
      const shim = join(bin, alias);
      const check = await run([shim, "config", "validate", "--file", "relative config.json", "--json"], caller, env);
      expect(check.code, check.stderr).toBe(0);
      expect(JSON.parse(check.stdout).data).toMatchObject({ valid: true, written: false });
      const input = await run([shim, "bot", "create", "--input", "@duplicate field.json", "--preview"], caller, env);
      expect(input.code).toBe(2);
      expect(JSON.parse(input.stdout || input.stderr).error.message).toBe("A semantic input field was supplied more than once.");
      const selected = await run([shim, "config", "path", "--json"], caller, env);
      expect(selected.code, selected.stderr).toBe(0);
      expect(JSON.parse(selected.stdout).data.path).toBe(join(env.GROKBOX_CONFIG_DIR, "config.json"));
      const withoutExport: NodeJS.ProcessEnv = { ...env }; delete withoutExport.GROKBOX_CONFIG_DIR;
      const defaulted = await run([shim, "config", "path", "--json"], caller, withoutExport);
      expect(defaulted.code, defaulted.stderr).toBe(0);
      expect(JSON.parse(defaulted.stdout).data.path).toBe(join(fixture, ".grokbox", "config.json"));
    }
    const absent = await run([process.execPath, "run", "--no-env-file", "--cwd", repoRoot,
      join(repoRoot, "scripts/source-cli.ts"), join(fixture, "absent"), "--version"], repoRoot, env);
    expect(absent.code).toBe(127); expect(absent.stdout).toBe("");
    expect(absent.stderr).toBe("grokbox local shim: caller directory is unavailable\n");
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 20000);
