import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import cliPackage from "../package.json" with { type: "json" };
import {
  jobStateProvesCleanup,
  productErrorCodeFromText,
} from "../scripts/external-validation-helpers.mjs";
import {
  MINIMUM_NODE_MAJOR,
  RUNTIME_UNSUPPORTED_EXIT_CODE,
  runtimeUnsupportedEnvelope,
  supportsNodeRuntime,
} from "../bin/runtime.js";

const repoRoot = join(import.meta.dir, "..");
const bun = Bun.which("bun") ?? process.execPath;

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function run(
  argv: string[],
  cwd = repoRoot,
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), child.exited]);
  return { code, stdout, stderr };
}

function trashRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), ".Trash")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
}

describe("published Node package", () => {
  test("runtime gate rejects Node below 20 with one stable redacted envelope", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(20);
    expect(RUNTIME_UNSUPPORTED_EXIT_CODE).toBe(59);
    expect(supportsNodeRuntime("19.9.0")).toBe(false);
    expect(supportsNodeRuntime("20.0.0")).toBe(true);
    expect(supportsNodeRuntime("invalid")).toBe(false);
    expect(runtimeUnsupportedEnvelope("19.9.0")).toEqual({
      ok: false,
      error: {
        code: "runtime_unsupported",
        message: "grokbox requires Node.js 20 or newer.",
        retryable: false,
        runtime: { nodeMajor: 19, minimumNodeMajor: 20 },
      },
    });
  });

  test("external evidence classifiers reject arbitrary failures and unknown Job cleanup", () => {
    expect(productErrorCodeFromText('{"ok":false,"error":{"code":"capability_unavailable"}}'))
      .toBe("capability_unavailable");
    expect(productErrorCodeFromText("node crashed")).toBeNull();
    expect(productErrorCodeFromText("{}")).toBeNull();
    for (const state of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]) {
      expect(jobStateProvesCleanup(state)).toBe(true);
    }
    for (const state of ["unknown", "running", "queued", undefined]) {
      expect(jobStateProvesCleanup(state)).toBe(false);
    }
  });

  test("external harness refuses absent injected targets before build or mutation", async () => {
    const env = { ...process.env };
    for (const name of [
      "GROKBOX_EXTERNAL_RUNNER",
      "GROKBOX_EXTERNAL_PEER",
      "GROKBOX_EXTERNAL_AGENT",
      "GROKBOX_EXTERNAL_EMPTY_FILE",
      "GROKBOX_EXTERNAL_MUTATION_ROOT",
    ]) delete env[name];
    const result = await run([process.execPath, join(repoRoot, "scripts", "verify-external.mjs")], repoRoot, env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Set GROKBOX_EXTERNAL_RUNNER");
    expect(result.stderr).not.toContain("npm pack");
    expect(result.stderr).not.toContain("ssh");
  });

  test("external registry lane requires one exact grokbox version", async () => {
    const env = {
      ...process.env,
      GROKBOX_EXTERNAL_RUNNER: "not-contacted",
      GROKBOX_EXTERNAL_PEER: "not-contacted",
      GROKBOX_EXTERNAL_AGENT: "grokbox",
      GROKBOX_EXTERNAL_EMPTY_FILE: "e2e:/empty.txt",
      GROKBOX_EXTERNAL_MUTATION_ROOT: "e2e",
      GROKBOX_EXTERNAL_PACKAGE: "other-package@latest",
    };
    const result = await run([process.execPath, join(repoRoot, "scripts", "verify-external.mjs")], repoRoot, env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be an exact grokbox package version");
    expect(result.stderr).not.toContain("SSH boundary");
  });

  test("package tarball installs in Trash and both aliases are exact Node-only entrypoints", async () => {
    await mkdir(trashRoot(), { recursive: true });
    const fixture = await mkdtemp(join(trashRoot(), "grokbox-package-test-"));
    const build = await run([bun, "run", "build"]);
    expect(build.code, build.stderr).toBe(0);

    const npm = Bun.which("npm");
    let archivePath: string;
    let paths: string[];
    if (npm) {
      const packed = await run([
        npm,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        fixture,
        repoRoot,
      ]);
      expect(packed.code, packed.stderr).toBe(0);
      const manifest = JSON.parse(packed.stdout) as Array<{
        filename: string;
        files: Array<{ path: string }>;
      }>;
      expect(manifest).toHaveLength(1);
      archivePath = join(fixture, manifest[0]!.filename);
      paths = manifest[0]!.files.map((entry) => entry.path).sort();
    } else {
      const packed = await run([
        bun,
        "pm",
        "pack",
        "--ignore-scripts",
        "--destination",
        fixture,
        "--quiet",
      ]);
      expect(packed.code, packed.stderr).toBe(0);
      archivePath = packed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      expect(archivePath.startsWith(`${fixture}/`)).toBe(true);
      const listed = await run(["tar", "-tzf", archivePath]);
      expect(listed.code, listed.stderr).toBe(0);
      paths = [...new Set(listed.stdout.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("package/") && line !== "package/")
        .map((line) => line.slice("package/".length)))].sort();
    }
    expect(paths).toEqual([
      "LICENSE",
      "README.md",
      "README.zh-CN.md",
      "THIRD_PARTY_NOTICES",
      "bin/grokbox",
      "bin/runtime.d.ts",
      "bin/runtime.js",
      "dist/index.js",
      "package.json",
      "skills/core.md",
    ]);

    const prefix = join(fixture, "prefix");
    const installed = npm
      ? await run([
          npm,
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--prefix",
          prefix,
          archivePath,
        ])
      : await run([bun, "add", "--global", "--exact", archivePath], repoRoot, {
          ...process.env,
          BUN_INSTALL: prefix,
        });
    expect(installed.code, installed.stderr).toBe(0);
    const binDir = npm ? join(prefix, "node_modules", ".bin") : join(prefix, "bin");
    const grokbox = join(binDir, "grokbox");
    const gbox = join(binDir, "gbox");
    const [grokboxHelp, gboxHelp, grokboxVersion, gboxVersion] = await Promise.all([
      run([grokbox, "--help"]),
      run([gbox, "--help"]),
      run([grokbox, "--version"]),
      run([gbox, "--version"]),
    ]);
    expect(grokboxHelp.code, grokboxHelp.stderr).toBe(0);
    expect(gboxHelp.code, gboxHelp.stderr).toBe(0);
    expect(grokboxHelp.stdout).toBe(gboxHelp.stdout);
    expect(grokboxHelp.stdout).toContain("recover");
    expect(grokboxVersion.stdout.trim()).toBe(cliPackage.version);
    expect(gboxVersion.stdout).toBe(grokboxVersion.stdout);

    const installedRoot = npm
      ? join(prefix, "node_modules", "grokbox")
      : join(prefix, "install", "global", "node_modules", "grokbox");
    const runtimeText = `${await readFile(join(installedRoot, "bin", "grokbox"), "utf8")}\n${await readFile(join(installedRoot, "dist", "index.js"), "utf8")}`;
    expect(runtimeText).not.toContain("Bun.");
    const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    expect(installedPackage.private).toBeUndefined();
    expect(installedPackage).toMatchObject({
      license: "MIT",
      engines: { node: ">=20.0.0" },
      repository: { url: "https://github.com/yoyooyooo/grokbox.git" },
      bin: { grokbox: "bin/grokbox", gbox: "bin/grokbox" },
      dependencies: {},
      publishConfig: { access: "public", provenance: true },
    });
    expect(await readFile(join(installedRoot, "LICENSE"), "utf8")).toContain("MIT License");
    const notices = await readFile(join(installedRoot, "THIRD_PARTY_NOTICES"), "utf8");
    expect(notices).toContain("Commander.js");
    expect(notices).toContain("Copyright (c) 2011 TJ Holowaychuk");
  }, 30_000);
});
