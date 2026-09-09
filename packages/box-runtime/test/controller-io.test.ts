import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectControllerFacts,
  resetLiveMutationAttempts,
  liveMutationAttempts,
  startControlOperation,
} from "../src/internal/roots/controller-program.node.ts";
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
      expect(inspectControllerFacts(boxRoot)).toMatchObject({ ok: false, reason: "live-not-proven" });
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
