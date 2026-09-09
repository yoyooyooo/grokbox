import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectControllerFacts,
  resetLiveMutationAttempts,
  liveMutationAttempts,
  startControlOperation,
} from "../src/internal/roots/controller-program.node.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";

async function emptyRoot() {
  return await mkdtemp(join(tmpdir(), "grokbox-t28-ctrl-"));
}

describe("controller IO facade", () => {
  test("inspect distinguishes missing facts; mutation attempts stay zero", async () => {
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
      await writeFile(reviewedProfilePath(boxRoot), `${JSON.stringify({
        profileId: "p", sourceSha256: "a".repeat(64), transformedSourceSha256: "b".repeat(64), slices: [],
      })}\n`);
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
