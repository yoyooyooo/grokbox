import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { readBoundedJson } from "../src/internal/io/bounded-json.node.ts";
import { acquireConfigurationLease, inspectConfigurationLease } from "../src/internal/io/config-lock.node.ts";

type BufferRead = (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;

// These tests use disposable real files. Only the specified syscall outcome is
// controlled, and the original built-in method is restored before cleanup.
test("bounded JSON completes short regular-file reads instead of accepting a numeric prefix", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "gbox-json-short-")), file = join(root, "value.json");
  await fs.writeFile(file, "12345");
  const handle = await fs.open(file, "r"), prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const original = prototype.read as BufferRead;
  let reads = 0;
  const controlled = spyOn(prototype, "read").mockImplementation((async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    reads++;
    return original.call(this, buffer, offset, Math.min(length, 1), position);
  }) as typeof prototype.read);
  try {
    expect(await readBoundedJson(file)).toBe(12345);
    expect(reads).toBeGreaterThan(1);
  } finally { controlled.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});

test("bounded JSON refuses an in-place change during its read", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "gbox-json-change-")), file = join(root, "value.json");
  await fs.writeFile(file, '{"value":"before"}');
  const handle = await fs.open(file, "r"), prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const original = prototype.read as BufferRead;
  let changed = false;
  const controlled = spyOn(prototype, "read").mockImplementation((async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    const result = await original.call(this, buffer, offset, length, position);
    if (!changed) {
      changed = true;
      await fs.writeFile(file, '{"value":"after!"}');
      await fs.utimes(file, new Date(1_000), new Date(1_000));
    }
    return result;
  }) as typeof prototype.read);
  try {
    expect(await readBoundedJson(file)).toBeUndefined();
    expect(changed).toBe(true);
  } finally { controlled.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});

test("bounded JSON retains byte limits, no-follow and strict UTF-8 without imposing private-file permissions", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "gbox-json-bounds-")), file = join(root, "value.json");
  try {
    await fs.writeFile(file, '{"catalog":true}', { mode: 0o644 });
    expect(await readBoundedJson(file)).toEqual({ catalog: true });
    const link = join(root, "alias.json"); await fs.symlink(file, link);
    expect(await readBoundedJson(link)).toBeUndefined();
    await fs.writeFile(file, Buffer.from([0x22, 0xff, 0x22]));
    expect(await readBoundedJson(file)).toBeUndefined();
    await fs.writeFile(file, Buffer.alloc(CONFIG_READ_MAX_BYTES + 1, 0x20));
    expect(await readBoundedJson(file)).toBeUndefined();
    expect(await readBoundedJson(join(root, "missing.json"))).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function lockFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "gbox-lock-view-"));
  await fs.mkdir(join(root, "state"), { mode: 0o700 });
  const path = join(root, "state/config-write.lock");
  const text = JSON.stringify({ schemaVersion: 1, pid: process.pid, uid: process.getuid!(), start: null, nonce: randomUUID() });
  await fs.writeFile(path, text, { mode: 0o600 });
  return { root, path, text };
}

test.skipIf(process.platform !== "linux")("lease inspection derives state and recoverability from one owner observation", async () => {
  const f = await lockFixture(), original = fs.lstat;
  let ownerReads = 0;
  const controlled = spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === `/proc/${process.pid}` && ++ownerReads > 1) throw Object.assign(Error("synthetic exited owner"), { code: "ENOENT" });
    return original(...args);
  }) as typeof fs.lstat);
  try {
    expect(await inspectConfigurationLease(f.root)).toMatchObject({ state: "live-or-unproven", recoverable: false });
    expect(ownerReads).toBe(1);
  } finally { controlled.mockRestore(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("a lock disappearing before recovery inspection is a typed conflict without removing an owner", async () => {
  const f = await lockFixture(), original = fs.lstat;
  const controlled = spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.path) throw Object.assign(Error("synthetic released lock"), { code: "ENOENT" });
    return original(...args);
  }) as typeof fs.lstat);
  try {
    await expect(acquireConfigurationLease(f.root, true)).rejects.toMatchObject({ code: "config_conflict" });
    expect(await fs.readFile(f.path, "utf8")).toBe(f.text);
  } finally { controlled.mockRestore(); await fs.rm(f.root, { recursive: true, force: true }); }
});
