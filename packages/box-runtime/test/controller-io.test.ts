import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlOperation } from "../src/internal/roots/controller-program.node.ts";

describe("controller IO facade", () => {
  test("confirmed apply on empty disposable root refuses with zero mutation", async () => {
    const boxRoot = await mkdtemp(join(tmpdir(), "grokbox-t28-ctrl-"));
    const receipt = await startControlOperation({
      intent: "apply",
      confirmed: true,
      operationId: "op-empty",
      boxRoot,
    });
    expect(receipt).toMatchObject({
      outcome: "refused",
      reason: "preflight-incomplete",
      signaled: false,
      spawned: false,
      guardian: false,
      operationId: "op-empty",
    });
  });

  test("reconcile never signals", async () => {
    const boxRoot = await mkdtemp(join(tmpdir(), "grokbox-t28-rec-"));
    const receipt = await startControlOperation({
      intent: "reconcile",
      confirmed: false,
      operationId: "op-reconcile",
      boxRoot,
    });
    expect(receipt.signaled).toBe(false);
    expect(receipt.spawned).toBe(false);
    expect(receipt.guardian).toBe(false);
  });
});
