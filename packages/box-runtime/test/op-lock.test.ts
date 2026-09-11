import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireExclusiveLock } from "../src/internal/io/op-lock.ts";

describe("exclusive lock ownership", () => {
  test("release unlinks the owned pathname", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t28-lock-"));
    await mkdir(join(dir, "state"), { recursive: true });
    const lockPath = join(dir, "state", "controller-operations.lock");
    const held = await acquireExclusiveLock(lockPath);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("expected lock");
    expect(existsSync(lockPath)).toBe(true);
    await held.lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release does not unlink a replaced competitor pathname", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t28-lock-"));
    await mkdir(join(dir, "state"), { recursive: true });
    const lockPath = join(dir, "state", "controller-operations.lock");
    const backup = join(dir, "state", "original-owned-lock");
    const held = await acquireExclusiveLock(lockPath);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("expected lock");
    await rename(lockPath, backup);
    await writeFile(lockPath, "synthetic-competing-lock\n");
    await held.lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(await readFile(lockPath, "utf8")).toBe("synthetic-competing-lock\n");
    expect(existsSync(backup)).toBe(true);
    expect(await readFile(backup, "utf8")).toMatch(/^\d+\n$/);
  });
});
