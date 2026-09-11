import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlOperation } from "../src/internal/roots/controller-program.node.ts";

async function emptyRoot() {
  return await mkdtemp(join(tmpdir(), "grokbox-t28-lock-"));
}

describe("controller lock ownership", () => {
  test("initial store publish failure releases the exclusive lock", async () => {
    const boxRoot = await emptyRoot();
    await mkdir(join(boxRoot, "state"), { recursive: true });
    const store = join(boxRoot, "state", "controller-operations.json");
    const lock = join(boxRoot, "state", "controller-operations.lock");
    await writeFile(store, "{}\n");
    // Occupy the pid tmp name so publish throws after the exclusive lock is held.
    await mkdir(`${store}.${process.pid}.tmp`);
    const first = await startControlOperation({
      intent: "apply",
      confirmed: true,
      operationId: "owned-operation",
      boxRoot,
      strategy: "direct",
    });
    expect(first).toMatchObject({ outcome: "refused", reason: "lease-failed", signaled: false });
    expect(existsSync(lock)).toBe(false);
    await rmdir(`${store}.${process.pid}.tmp`);
    const retry = await startControlOperation({
      intent: "apply",
      confirmed: true,
      operationId: "new-operation",
      boxRoot,
      strategy: "direct",
    });
    expect(retry.reason).not.toBe("operation-busy");
    expect(existsSync(lock)).toBe(false);
  });
});
