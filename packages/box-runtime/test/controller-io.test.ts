import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveAdoptLaunchSpec } from "../src/internal/process/h3-live.ts";
import {
  HOST_CHILD_STDIO,
  IDENTITY_LAUNCH_ALLOWLIST,
  pickLaunchEnv,
} from "../src/internal/process/launch.node.ts";
import {
  inspectControllerFacts,
  resetLiveMutationAttempts,
  liveMutationAttempts,
  startControlOperation,
  type LiveAdmissionPorts,
} from "../src/internal/roots/controller-program.node.ts";
import type { ProcessIdentity } from "../src/internal/process/process-port.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";
import { SYNTHETIC_SLICES } from "./synthetic-host.ts";

async function emptyRoot() {
  return await mkdtemp(join(tmpdir(), "grokbox-t28-ctrl-"));
}

const validProfile = {
  profileId: "synthetic",
  sourceSha256: "a".repeat(64),
  transformedSourceSha256: "b".repeat(64),
  slices: SYNTHETIC_SLICES,
};

async function writeFacts(boxRoot: string, profile: unknown = validProfile) {
  await mkdir(join(boxRoot, "state"), { recursive: true });
  await mkdir(join(boxRoot, "profiles"), { recursive: true });
  await writeFile(join(boxRoot, "state", "desired.json"), `${JSON.stringify({ version: 1, mode: "identity" })}\n`);
  await writeFile(join(boxRoot, "models.json"), `${JSON.stringify({
    version: 1, models: {}, assignments: { main: null, agents: {} },
  })}\n`);
  await writeFile(reviewedProfilePath(boxRoot), `${JSON.stringify(profile)}\n`);
}

describe("controller IO facade", () => {
  test("inspect distinguishes missing facts and reviewed-profile mismatch", async () => {
    resetLiveMutationAttempts();
    const kills: Array<{ pid: number; sig: unknown }> = [];
    const original = process.kill;
    process.kill = ((pid: number, sig?: NodeJS.Signals | number) => {
      kills.push({ pid, sig });
      return original.call(process, pid, sig as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const boxRoot = await emptyRoot();
      expect(inspectControllerFacts(boxRoot).reason).toBe("missing-desired");
      const receipt = await startControlOperation({
        intent: "apply",
        confirmed: true,
        operationId: "op-empty",
        boxRoot,
      });
      expect(receipt).toMatchObject({
        outcome: "refused",
        reason: "missing-desired",
        signaled: false,
        spawned: false,
        guardian: false,
      });
      expect(liveMutationAttempts).toEqual({ signal: 0, spawn: 0, guardian: 0 });
      expect(kills).toEqual([]);

      await mkdir(join(boxRoot, "state"), { recursive: true });
      await writeFile(join(boxRoot, "state", "desired.json"), `${JSON.stringify({ version: 1, mode: "route" })}\n`);
      expect(inspectControllerFacts(boxRoot).reason).toBe("missing-models");
      await writeFile(join(boxRoot, "models.json"), `${JSON.stringify({
        version: 1, models: {}, assignments: { main: null, agents: {} },
      })}\n`);
      expect(inspectControllerFacts(boxRoot).reason).toBe("missing-source");
      await mkdir(join(boxRoot, "profiles"), { recursive: true });
      await writeFile(reviewedProfilePath(boxRoot), "not-json\n");
      expect(inspectControllerFacts(boxRoot).reason).toBe("invalid-source");
      await writeFile(reviewedProfilePath(boxRoot), `${JSON.stringify({ hello: "world" })}\n`);
      expect(inspectControllerFacts(boxRoot).reason).toBe("unreviewed-profile");
      await writeFile(reviewedProfilePath(boxRoot), `${JSON.stringify({
        ...validProfile,
        sourceSha256: "not-a-digest",
      })}\n`);
      expect(inspectControllerFacts(boxRoot).reason).toBe("invalid-compile");
      await writeFile(reviewedProfilePath(boxRoot), `${JSON.stringify(validProfile)}\n`);
      expect(inspectControllerFacts(boxRoot)).toMatchObject({ ok: false, reason: "host-missing" });
      const complete = await startControlOperation({
        intent: "apply", confirmed: true, operationId: "op-complete", boxRoot,
      });
      expect(complete.signaled).toBe(false);
      expect(complete.spawned).toBe(false);
      expect(liveMutationAttempts.signal).toBe(0);
      expect(kills).toEqual([]);
    } finally {
      process.kill = original;
    }
  });

  test("corrupt operation store refuses instead of re-executing", async () => {
    resetLiveMutationAttempts();
    const boxRoot = await emptyRoot();
    await writeFacts(boxRoot);
    await writeFile(join(boxRoot, "state", "controller-operations.json"), "null\n");
    const apply = await startControlOperation({
      intent: "apply", confirmed: true, operationId: "op-corrupt", boxRoot, strategy: "direct",
    });
    expect(apply).toMatchObject({ outcome: "recovery-required", reason: "store-corrupt", signaled: false });
    const reconcile = await startControlOperation({
      intent: "reconcile", confirmed: false, operationId: "op-corrupt", boxRoot,
    });
    expect(reconcile).toMatchObject({ outcome: "recovery-required", reason: "store-corrupt" });
    expect(liveMutationAttempts).toEqual({ signal: 0, spawn: 0, guardian: 0 });
  });

  test("two processes cannot both acquire the file lease", async () => {
    const boxRoot = await emptyRoot();
    await mkdir(join(boxRoot, "state"), { recursive: true });
    const worker = fileURLToPath(new URL("./controller-lease-worker.ts", import.meta.url));
    const firstOut = join(boxRoot, "a.json");
    const secondOut = join(boxRoot, "b.json");
    const first = spawn("bun", [worker, boxRoot, firstOut], { stdio: "ignore" });
    const started = Date.now();
    while (Date.now() - started < 4000) {
      try {
        const text = await readFile(firstOut, "utf8");
        if (text.includes("acquired")) break;
      } catch {
        /* wait */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.parse(await readFile(firstOut, "utf8"))).toEqual({ status: "acquired" });
    const second = spawn("bun", [worker, boxRoot, secondOut], { stdio: "ignore" });
    const secondStarted = Date.now();
    while (Date.now() - secondStarted < 4000) {
      try {
        const text = await readFile(secondOut, "utf8");
        if (text.trim().length > 0) break;
      } catch {
        /* wait */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.parse(await readFile(secondOut, "utf8"))).toEqual({ status: "busy" });
    first.kill("SIGTERM");
    second.kill("SIGTERM");
  });

  test("Node20 two processes cannot both acquire the file lease", async () => {
    const boxRoot = await emptyRoot();
    await mkdir(join(boxRoot, "state"), { recursive: true });
    const worker = fileURLToPath(new URL("./controller-lease-worker.ts", import.meta.url));
    const bundle = join(boxRoot, "lease-worker.mjs");
    const build = spawn("bun", ["build", worker, "--outfile", bundle, "--target", "node"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      build.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`bun build ${code}`)));
    });
    const firstOut = join(boxRoot, "a.json");
    const secondOut = join(boxRoot, "b.json");
    const first = spawn("/usr/bin/node", [bundle, boxRoot, firstOut], { stdio: "ignore" });
    const started = Date.now();
    while (Date.now() - started < 4000) {
      try {
        const text = await readFile(firstOut, "utf8");
        if (text.includes("acquired")) break;
      } catch {
        /* wait */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.parse(await readFile(firstOut, "utf8"))).toEqual({ status: "acquired" });
    const second = spawn("/usr/bin/node", [bundle, boxRoot, secondOut], { stdio: "ignore" });
    const secondStarted = Date.now();
    while (Date.now() - secondStarted < 4000) {
      try {
        const text = await readFile(secondOut, "utf8");
        if (text.trim().length > 0) break;
      } catch {
        /* wait */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.parse(await readFile(secondOut, "utf8"))).toEqual({ status: "busy" });
    first.kill("SIGTERM");
    second.kill("SIGTERM");
  });

  test("live admission refuses absent Host and sha/pid mismatch; matching fixture admits without signal", async () => {
    resetLiveMutationAttempts();
    const boxRoot = await emptyRoot();
    await writeFacts(boxRoot);
    const kills: number[] = [];
    const original = process.kill;
    process.kill = ((pid: number, sig?: NodeJS.Signals | number) => {
      kills.push(pid);
      return original.call(process, pid, sig as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const wrapper: ProcessIdentity = {
        pid: 11, uid: 1000, start: 100, exe: "/bin/bash", ppid: 1, ancestry: [1],
        cmdline: ["bash", "/usr/local/bin/supervise-sand-supervisor"],
      };
      const supervisor: ProcessIdentity = {
        pid: 12, uid: 1000, start: 101, exe: "/exec-daemon/node", ppid: 11, ancestry: [11, 1],
        cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
      };
      const host: ProcessIdentity = {
        pid: 13, uid: 1000, start: 102, exe: "/exec-daemon/node", ppid: 12, ancestry: [12, 11, 1],
        cmdline: ["/exec-daemon/node", "/tmp/host-main.cjs"],
      };
      const rows = [wrapper, supervisor, host];
      const portFor = (gatewayPid: number | null, sha: string): LiveAdmissionPorts => ({
        processes: {
          inspect: (pid) => rows.find((row) => row.pid === pid) ?? null,
          list: () => rows,
          signal: () => ({ ok: false, reason: "not-found" }),
        },
        classify: (ident) => {
          if (ident.pid === 11) return "wrapper";
          if (ident.pid === 12) return "supervisor";
          if (ident.pid === 13) return "host";
          return null;
        },
        gatewayPid: () => gatewayPid,
        hostBundlePath: "/tmp/host-main.cjs",
        readHostSha: () => sha,
      });
      expect(inspectControllerFacts(boxRoot, {
        processes: { inspect: () => null, list: () => [], signal: () => ({ ok: false, reason: "not-found" }) },
        classify: () => null,
        gatewayPid: () => null,
        hostBundlePath: "/tmp/missing.cjs",
        readHostSha: () => null,
      }).reason).toBe("host-bundle-missing");
      expect(inspectControllerFacts(boxRoot, {
        processes: { inspect: () => null, list: () => [], signal: () => ({ ok: false, reason: "not-found" }) },
        classify: () => null,
        gatewayPid: () => null,
        hostBundlePath: "/tmp/host-main.cjs",
        readHostSha: () => validProfile.sourceSha256,
      }).reason).toBe("host-missing");
      expect(inspectControllerFacts(boxRoot, portFor(13, "c".repeat(64))).reason).toBe("source-mismatch");
      expect(inspectControllerFacts(boxRoot, portFor(99, validProfile.sourceSha256)).reason).toBe("gateway-mismatch");
      const admitted = inspectControllerFacts(boxRoot, portFor(13, validProfile.sourceSha256));
      expect(admitted).toMatchObject({ ok: true, reason: null, strategy: "direct" });
      const adoptedHost: ProcessIdentity = {
        ...host,
        ppid: 53,
        ancestry: [53, 1],
      };
      const adoptedRows = [wrapper, supervisor, adoptedHost];
      const adoptedLive: LiveAdmissionPorts = {
        processes: {
          inspect: (pid) => adoptedRows.find((row) => row.pid === pid) ?? null,
          list: () => adoptedRows,
          signal: () => ({ ok: false, reason: "not-found" }),
        },
        classify: (ident) => {
          if (ident.pid === 11) return "wrapper";
          if (ident.pid === 12) return "supervisor";
          if (ident.pid === 13) return "host";
          return null;
        },
        gatewayPid: () => 13,
        hostBundlePath: "/tmp/host-main.cjs",
        readHostSha: () => validProfile.sourceSha256,
      };
      expect(inspectControllerFacts(boxRoot, adoptedLive)).toMatchObject({ ok: true, reason: null });
      expect(inspectControllerFacts(boxRoot, { ...adoptedLive, gatewayPid: () => 99 }).reason).toBe("gateway-mismatch");
      expect(kills).toEqual([]);
      expect(liveMutationAttempts).toEqual({ signal: 0, spawn: 0, guardian: 0 });
    } finally {
      process.kill = original;
    }
  });

  test("reconcile never signals", async () => {
    resetLiveMutationAttempts();
    const boxRoot = await emptyRoot();
    const receipt = await startControlOperation({
      intent: "reconcile",
      confirmed: false,
      operationId: "op-reconcile",
      boxRoot,
    });
    expect(receipt.signaled).toBe(false);
    expect(receipt.spawned).toBe(false);
    expect(receipt.guardian).toBe(false);
    expect(liveMutationAttempts).toEqual({ signal: 0, spawn: 0, guardian: 0 });
  });
});

const NODE20 = "/usr/bin/node";
const SOURCE_HELPER = fileURLToPath(new URL("../src/internal/process/helpers/grokbox-temp-supervisor.cjs", import.meta.url));
const RAW_SINK = "/tmp/sand-host-adopt.err";

async function waitForFile(path: string, timeoutMs = 4000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim().length > 0) return text;
    } catch {
      /* wait */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runRawOutputHelper(helperPath: string) {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-t22-raw-"));
  const sentinel = `T22_SENTINEL_${randomUUID()}`;
  const secret = `sk-live-${randomUUID()}`;
  const renewer = `renewal-${randomUUID()}`;
  const reportPath = join(dir, "report.json");
  const childPath = join(dir, "child.cjs");
  await writeFile(childPath, `"use strict";
const { writeFileSync, readlinkSync } = require("node:fs");
process.stdout.write(process.env.T22_SENTINEL + "\\n");
process.stderr.write(process.env.T22_SENTINEL + "-err\\n");
writeFileSync(process.argv[2], JSON.stringify({
  fd1: readlinkSync("/proc/self/fd/1"),
  fd2: readlinkSync("/proc/self/fd/2"),
  renewer: process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL ?? null,
  gateway: process.env.SAND_GATEWAY_TOKEN ?? null,
  secret: process.env.ACME_KEY ?? null,
  openai: process.env.OPENAI_API_KEY ?? null,
  sentinelEnv: process.env.T22_SENTINEL ?? null,
}) + "\\n");
`);
  const picked = pickLaunchEnv({
    HOME: dir,
    PATH: process.env.PATH,
    SAND_INFERENCE_RENEWAL_CREDENTIAL: renewer,
    SAND_GATEWAY_TOKEN: "gw-token",
    ACME_KEY: secret,
    OPENAI_API_KEY: secret,
    T22_SENTINEL: sentinel,
  });
  expect(picked.ok).toBe(true);
  if (!picked.ok) throw new Error("pickLaunchEnv failed");
  expect(picked.env.SAND_INFERENCE_RENEWAL_CREDENTIAL).toBe(renewer);
  expect(picked.env.ACME_KEY).toBeUndefined();
  const spec = {
    execPath: NODE20,
    argv: [childPath, reportPath],
    cwd: dir,
    env: { ...picked.env, T22_SENTINEL: sentinel },
    stdio: HOST_CHILD_STDIO,
  };
  await writeFile(join(dir, "spec.json"), `${JSON.stringify(spec)}\n`);
  const existed = existsSync(RAW_SINK);
  const before = existed ? readFileSync(RAW_SINK, "utf8") : null;
  const helper = spawn(NODE20, [helperPath, join(dir, "spec.json")], {
    stdio: "ignore",
    env: { ...process.env, ACME_KEY: secret, OPENAI_API_KEY: secret },
  });
  try {
    const report = JSON.parse(await waitForFile(reportPath));
    expect(report.fd1).toBe("/dev/null");
    expect(report.fd2).toBe("/dev/null");
    expect(report.renewer).toBe(renewer);
    expect(report.gateway).toBe("gw-token");
    expect(report.secret).toBeNull();
    expect(report.openai).toBeNull();
    if (!existed) expect(existsSync(RAW_SINK)).toBe(false);
    else {
      expect(readFileSync(RAW_SINK, "utf8")).toBe(before ?? "");
      expect((before ?? "").includes(sentinel)).toBe(false);
    }
  } finally {
    helper.kill("SIGTERM");
  }
  return { dir, sentinel, secret, renewer };
}

describe("raw output", () => {
  test("raw output default helper does not capture child stdout/stderr", async () => {
    expect(HOST_CHILD_STDIO).toEqual(["ignore", "ignore", "ignore"]);
    expect(IDENTITY_LAUNCH_ALLOWLIST).toContain("SAND_INFERENCE_RENEWAL_CREDENTIAL");
    const helperSource = readFileSync(SOURCE_HELPER, "utf8");
    expect(helperSource.includes("sand-host-adopt.err")).toBe(false);
    expect(helperSource.includes("openSync")).toBe(false);
    const spec = liveAdoptLaunchSpec({ PATH: "/usr/bin" }, {
      execPath: NODE20,
      hostBundle: "/tmp/host.js",
      cwd: "/tmp",
    });
    expect(spec.stdio).toEqual(["ignore", "ignore", "ignore"]);
    await runRawOutputHelper(SOURCE_HELPER);
  });

  test("raw output packed helper does not capture child stdout/stderr", async () => {
    const packedDir = await mkdtemp(join(tmpdir(), "grokbox-t22-packed-"));
    const packed = join(packedDir, "grokbox-temp-supervisor.cjs");
    await copyFile(SOURCE_HELPER, packed);
    await runRawOutputHelper(packed);
  });
});
