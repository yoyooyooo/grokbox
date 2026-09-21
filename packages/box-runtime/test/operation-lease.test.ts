import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOperationLease, inspectOperationLease } from "../src/internal/io/operation-lease.node.ts";

for (const replaced of [false, true]) test(`current operation release preserves pathname ownership, replaced=${replaced}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-operation-lock-")), path = join(root, "state", "controller-operations.lock");
  const held = await acquireOperationLease(path, "owned-request");
  try {
    expect(held.ok).toBe(true);
    if (!held.ok) throw Error("expected-lock");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(held.lock.owner);
    expect((await inspectOperationLease(path)).observation).toMatchObject({ state: "live", format: "identity-v1", recoverable: false });
    const backup = join(root, "state", "retained-original");
    if (replaced) {
      await rename(path, backup);
      await writeFile(path, "synthetic-competing-lock\n", { mode: 0o600 });
    }
    await held.lock.release(); await held.lock.release();
    if (replaced) {
      expect(await readFile(path, "utf8")).toBe("synthetic-competing-lock\n");
      expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(held.lock.owner);
    } else expect(existsSync(path)).toBe(false);
  } finally {
    if (held.ok) await held.lock.release();
    await rm(root, { recursive: true, force: true });
  }
});
