import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { acquireConfigurationLease, inspectConfigurationLease } from "../src/internal/io/config-lock.node.ts";

async function root() { return await mkdtemp(join(tmpdir(), "grokbox-config-lock-")); }

describe("configuration lease crash and recovery", () => {
  test("a live lease cannot be stolen, including by explicit recovery", async () => {
    const path = await root(); const held = await acquireConfigurationLease(path);
    try {
      await expect(acquireConfigurationLease(path)).rejects.toThrow("busy");
      await expect(acquireConfigurationLease(path, true)).rejects.toThrow("live or unproven");
      expect((await inspectConfigurationLease(path)).state).toBe("live-or-unproven");
    } finally { await held.release(); }
    expect((await inspectConfigurationLease(path)).state).toBe("absent");
  });
  test("unknown legacy lock bytes are preserved, not deleted by age", async () => {
    const path = await root(); await mkdir(join(path, "state"), { mode: 0o700 });
    const lock = join(path, "state", "config-write.lock"); await writeFile(lock, "42\n", { mode: 0o600 });
    await expect(acquireConfigurationLease(path, true)).rejects.toThrow("unproven");
    expect(await readFile(lock, "utf8")).toBe("42\n");
  });
  test("a real disposable process SIGKILL leaves a recoverable complete owner record", async () => {
    const path = await root();
    const child = spawn(process.execPath, [resolve(import.meta.dir, "fixtures/config-lock-child.ts"), path], { stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    try {
      const first = await Promise.race([
        once(child.stdout!, "data").then(([data]) => String(data)),
        once(child, "exit").then(() => { throw new Error("Test child exited before acquiring its lease."); }),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Test lease child did not become ready.")), 3000); timer.unref(); }),
      ]);
      expect(JSON.parse(first).pid).toBe(child.pid); ready = true;
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      expect((await inspectConfigurationLease(path)).state).toBe("stale");
      const results = await Promise.allSettled([acquireConfigurationLease(path, true), acquireConfigurationLease(path, true)]);
      const successful = results.filter((result) => result.status === "fulfilled");
      expect(successful).toHaveLength(1);
      for (const result of successful) if (result.status === "fulfilled") await result.value.release();
      expect((await inspectConfigurationLease(path)).state).toBe("absent");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(ready ? "SIGTERM" : "SIGKILL"); await exit; }
    }
  });
});
