import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlOperation } from "../src/internal/roots/controller-program.node.ts";

async function emptyRoot() {
  return await mkdtemp(join(tmpdir(), "grokbox-t28-lock-"));
}

(process.platform === "linux" ? describe : describe.skip)("controller lock ownership", () => {
  test("initial store publish failure releases the exclusive lock", async () => {
    const boxRoot = await emptyRoot();
    await mkdir(join(boxRoot, "state"), { recursive: true });
    const store = join(boxRoot, "state", "controller-operations.json");
    const lock = join(boxRoot, "state", "controller-operations.lock");
    await writeFile(store, "{}\n");
    // Fail publication after the exclusive lock is held, without relying on a
    // predictable staging pathname (new writers use unique protected staging).
    const failure = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture publication failure"); });
    try {
      const first = await startControlOperation({
        intent: "apply", confirmed: true, operationId: "owned-operation", boxRoot, strategy: "direct",
      });
      expect(first).toMatchObject({ outcome: "refused", reason: "lease-failed", signaled: false });
      expect(existsSync(lock)).toBe(false);
    } finally { failure.mockRestore(); }
    const retry = await startControlOperation({
      intent: "apply",
      confirmed: true,
      operationId: "new-operation",
      boxRoot,
      strategy: "direct",
    });
    expect(retry.reason).not.toBe("operation-busy");
    expect(existsSync(lock)).toBe(false);
    await rm(boxRoot, { recursive: true, force: true });
  });
});
