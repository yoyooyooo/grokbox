import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cliPackage from "../package.json" with { type: "json" };

const repoRoot = join(import.meta.dir, "..");
const installer = join(repoRoot, "scripts", "install-local-shim.mjs");

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function run(argv: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), child.exited]);
  return { stdout, stderr, code };
}

describe("source-backed local global shim", () => {
  test("installs exact executable aliases and runs the TypeScript entry from another cwd", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-test-"));
    const bin = join(fixture, "bin");
    const env = { ...process.env, GROKBOX_SHIM_DIR: bin };

    const first = await run(["bun", "run", installer], fixture, env);
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
    expect(grokboxText).toContain('exec "$bun" run "$repo/src/index.ts" "$@"');
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
  }, 20_000);

  test("refuses an unmanaged command before installing either alias", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "grokbox-shim-refusal-test-"));
    const bin = join(fixture, "bin");
    await mkdir(bin);
    const existing = join(bin, "grokbox");
    await writeFile(existing, "#!/bin/sh\necho unrelated\n", { mode: 0o755 });

    const result = await run(
      ["bun", "run", installer],
      fixture,
      { ...process.env, GROKBOX_SHIM_DIR: bin },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace unmanaged command");
    expect(await readFile(existing, "utf8")).toBe("#!/bin/sh\necho unrelated\n");
    await expect(stat(join(bin, "gbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
