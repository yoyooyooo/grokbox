import { describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import cliPackage from "../package.json" with { type: "json" };
import { liveH3AdoptAdapter, wireLiveManualReadopt } from "../packages/box-runtime/src/internal/process/live-readopt.ts";
import { runManualReadopt } from "../packages/box-runtime/src/internal/roots/controller.runtime.ts";
import { resolveRuntimeHelpers, RUNTIME_HELPER_FILES } from "../packages/box-runtime/src/internal/process/helpers/runtime-helpers.ts";
import { profileFromSource } from "../packages/box-runtime/src/internal/host/profile.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "../packages/box-runtime/test/synthetic-host.ts";
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
import { resolvePackageRoot } from "../packages/cli/src/deps.ts";

const repoRoot = join(import.meta.dir, "..");
const bun = Bun.which("bun") ?? process.execPath;
const nodeExecutable = existsSync("/exec-daemon/node")
  ? "/exec-daemon/node"
  : (Bun.which("node") ?? process.execPath);

function stubLiveAdoptPorts() {
  const processes = {
    inspect: () => null,
    list: () => [],
    signal: () => ({ ok: false as const, reason: "not-found" as const }),
  };
  return {
    processes,
    classify: () => null,
    waitHostGone: async () => true,
    supervisorRelaunch: async () => null,
    waitReady: async () => null,
    applyLaunchEnv: async () => undefined,
    hasGrokboxPreload: () => false,
    spawnTempSupervisor: async () => null,
    waitNewHost: async () => null,
    readGatewayPid: () => null,
    guardianDeadlineMs: 1,
    waitBudgetMs: 1,
    adoptProveMs: 1,
  };
}

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
  test("resolvePackageRoot maps cli source and dist layouts to the published root", () => {
    expect(resolvePackageRoot(join(repoRoot, "dist"))).toBe(repoRoot);
    expect(resolvePackageRoot(join(repoRoot, "packages", "cli", "src"))).toBe(repoRoot);
  });

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
      "dist/grokbox-temp-supervisor.cjs",
      "dist/guardian-child.cjs",
      "dist/index.js",
      "dist/injector-hold.cjs",
      "dist/observation-sqlite.cjs",
      "dist/preload.cjs",
      "package.json",
      "skills/core.md",
      "skills/grokbox/SKILL.md",
      "skills/grokbox/adopt.md",
      "skills/grokbox/label.md",
      "skills/grokbox/models.md",
      "skills/grokbox/ownership.md",
      "skills/grokbox/troubleshoot.md",
      "skills/stubs/grokbox.md",
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
    expect(grokboxHelp.stdout).toContain("grokbox skills get grokbox");
    const skill = await run([grokbox, "skills", "get", "grokbox"]);
    expect(skill.code, skill.stderr).toBe(0);
    expect(skill.stdout).toContain("grokbox host start");
    expect(skill.stdout).toContain("history outcome");
    expect(skill.stdout).toContain("--runtime");
    expect(skill.stdout).toMatch(/queued, not a reply/);
    expect(skill.stdout).not.toMatch(/data\.state\s*=\s*accepted/);
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
    expect(notices).toContain("Copyright (c) 2017 sql.js authors");

    // Verify the published companion after installation with no workspace
    // dependency resolution. Read operations must not initialize storage.
    const observationRoot = join(fixture, "installed-observation-data");
    const observationEnv = { PATH: process.env.PATH ?? "", HOME: fixture,
      GROKBOX_CONFIG_DIR: join(fixture,"observation-config"), GROKBOX_BOX_RUNTIME_ROOT: observationRoot };
    const absentObservation = await run([grokbox,"runtime","monitor","snapshot","--json"],fixture,observationEnv);
    expect(absentObservation.code).not.toBe(0);
    expect(existsSync(observationRoot)).toBe(false);
    const initializeObservation = await run([grokbox,"runtime","monitor","init","--confirm","--json"],fixture,observationEnv);
    expect(initializeObservation.code,initializeObservation.stderr).toBe(0);
    expect(JSON.parse(initializeObservation.stdout).data.created).toBe(true);
    const sqliteBytes = await readFile(join(observationRoot,"observability/observations.sqlite"));
    expect(sqliteBytes.subarray(0,16).toString()).toBe("SQLite format 3" + String.fromCharCode(0));
    const installedSnapshot = await run([gbox,"runtime","monitor","snapshot","--json"],fixture,observationEnv);
    expect(installedSnapshot.code,installedSnapshot.stderr).toBe(0);
    expect(JSON.parse(installedSnapshot.stdout).data.admissionAuthority).toBe(false);
    expect(await readFile(join(observationRoot,"observability/observations.sqlite"))).toEqual(sqliteBytes);

    const distDir = join(installedRoot, "dist");
    const published = resolveRuntimeHelpers(pathToFileURL(join(distDir, "index.js")).href);
    expect(Object.values(published).sort()).toEqual(
      RUNTIME_HELPER_FILES.map((name) => join(distDir, name)).sort(),
    );
    for (const helperPath of Object.values(published)) {
      expect(existsSync(helperPath), helperPath).toBe(true);
    }
    expect(existsSync(join(distDir, "preload.ts"))).toBe(false);
    expect(published.preload.endsWith("preload.cjs")).toBe(true);
    const bundle = await readFile(join(distDir, "index.js"), "utf8");
    expect(bundle).not.toContain("./preload.ts");

    const checked = await run([nodeExecutable, "--check", published.preload]);
    expect(checked.code, checked.stderr).toBe(0);
    for (const helperPath of [published.guardianChild, published.injectorHold, published.tempSupervisor]) {
      const syntax = await run([nodeExecutable, "--check", helperPath]);
      expect(syntax.code, syntax.stderr).toBe(0);
    }

    const work = await mkdtemp(join(tmpdir(), "grokbox-packed-preload-"));
    const copyPath = join(work, "host-main.cjs");
    const profilePath = join(work, "reviewed.json");
    const markerPath = join(work, "marker.json");
    const runningHost = `${SYNTHETIC_HOST}
setInterval(() => {}, 1000);
`;
    await writeFile(copyPath, runningHost);
    await writeFile(profilePath, `${JSON.stringify(profileFromSource(runningHost, SYNTHETIC_SLICES))}\n`);
    const child = spawn(nodeExecutable, [copyPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${published.preload}`,
        GROKBOX_HOST_BUNDLE: copyPath,
        GROKBOX_PATCH_PROFILE: profilePath,
        GROKBOX_PRELOAD_MARKER: markerPath,
        GROKBOX_PRELOAD_MODE: "identity",
        GROKBOX_OPERATION_ID: "packed-preload-op",
      },
      stdio: "ignore",
    });
    const started = Date.now();
    type PackedMarker = {
      compiled?: boolean;
      operationId?: string;
      transformed?: boolean;
      modeld?: boolean;
    };
    let marker: PackedMarker | null = null;
    while (Date.now() - started < 5000) {
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as PackedMarker;
        if (marker.compiled) break;
      } catch {
        /* not yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    expect(marker).toMatchObject({
      operationId: "packed-preload-op",
      compiled: true,
      transformed: true,
      modeld: false,
    });
    expect(copyPath).not.toContain("/home/box/sand-host");
    expect(copyPath).not.toContain("3136108");

    const spy = spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts").mockImplementation(() => stubLiveAdoptPorts());
    try {
      const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-packed-readopt-"));
      await writeFile(
        join(boxRuntimeRoot, "models.json"),
        `${JSON.stringify({ version: 1, models: {}, assignments: { main: null, agents: {} } })}\n`,
      );
      const wired = wireLiveManualReadopt({
        root: boxRuntimeRoot,
        ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-packed-readopt-eph-")),
        now: () => 0,
      });
      expect(spy).toHaveBeenCalled();
      const needle = (spy.mock.calls[0]?.[0] as { preloadNeedle?: string } | undefined)?.preloadNeedle;
      expect(typeof needle).toBe("string");
      expect(existsSync(needle!)).toBe(true);
      await expect(runManualReadopt({
        confirmed: true,
        root: boxRuntimeRoot,
        desired: { version: 1, mode: "identity" },
        models: { version: 1, models: {}, assignments: { main: null, agents: {} } },
        now: () => 0,
        ...wired,
        freshDiskSha: () => "none",
      })).rejects.toMatchObject({ code: "invalid_usage" });
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
