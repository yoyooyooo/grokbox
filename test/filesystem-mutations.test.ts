import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GovernedFilesystem, FS_TRANSFER_CHUNK_BYTES, FS_UPLOAD_MAX_BYTES, type FilesystemLifecycleHooks } from "@grokbox/box-runtime/runtime";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const barrier = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
async function fixture(hooks: FilesystemLifecycleHooks = {}) {
  const base = await mkdtemp(join(tmpdir(), "file-mutation-adapter-")), root = join(base, "root"), outside = join(base, "outside");
  await mkdir(root); await mkdir(outside); await mkdir(join(root, "docs"));
  const fs = await GovernedFilesystem.create([{ name: "home", path: root, operations: ["stat", "read", "write", "mkdir", "upload", "remove", "remove-recursive", "restore"] }], Date.now, hooks);
  return { base, root, outside, fs, close: async () => { await fs.close(); await rm(base, { recursive: true, force: true }); } };
}
/** These are the original descriptor/serialization scenarios, now independent of
 * the retired daemon transport. Managed CLI/HTTP and crash proof live separately. */
for (const move of ["replace-path", "escape-root", "rename-concurrent"] as const) test(`pinned mutation parent: ${move}`, async () => {
  const f = await fixture(), entered = barrier(), release = barrier();
  const probe = await open(join(f.root, "docs"), "r"), prototype = Object.getPrototypeOf(probe), original = prototype.sync;
  await probe.close(); let first = true;
  prototype.sync = async function () { if (first) { first = false; entered.release(); await release.promise; } return original.call(this); };
  try {
    await writeFile(join(f.root, "docs/value.txt"), "before");
    const id = randomUUID(), pending = f.fs.write(id, "home:/docs/value.txt", Buffer.from("first"), digest("before"));
    await entered.promise;
    const destination = move === "escape-root" ? join(f.outside, "relocated") : join(f.root, "original");
    await rename(join(f.root, "docs"), destination);
    if (move === "replace-path") await symlink(f.outside, join(f.root, "docs"));
    const second = move === "rename-concurrent" ? f.fs.write(randomUUID(), "home:/original/value.txt", Buffer.from("second"), digest("before")) : undefined;
    release.release();
    if (move === "escape-root") {
      await expect(pending).rejects.toMatchObject({ code: "fs_forbidden" });
      expect(await readFile(join(destination, "value.txt"), "utf8")).toBe("before");
    } else {
      expect(await pending).toMatchObject({ state: "committed" });
      if (second) await expect(second).rejects.toMatchObject({ code: "fs_conflict" });
      expect(await readFile(join(destination, "value.txt"), "utf8")).toBe("first");
      expect(await f.fs.write(id, "home:/docs/value.txt", Buffer.from("first"), digest("before"))).toMatchObject({ state: "committed" });
      await expect(f.fs.write(id, "home:/docs/value.txt", Buffer.from("different"))).rejects.toMatchObject({ code: "fs_conflict" });
      expect(await readdir(f.outside)).toEqual([]);
    }
  } finally { release.release(); prototype.sync = original; await f.close(); }
});

test("closing awaits pending upload admission and leaves no published destination or descriptor", async () => {
  const f = await fixture(), entered = barrier(), release = barrier();
  await writeFile(join(f.root, "docs/pending.bin"), "baseline");
  const probe = await open(join(f.root, "docs/pending.bin"), "r"), prototype = Object.getPrototypeOf(probe), original = prototype.read;
  await probe.close(); let first = true;
  prototype.read = async function (...args: unknown[]) { if (first) { first = false; entered.release(); await release.promise; } return original.apply(this, args); };
  try {
    const pending = f.fs.openUpload(randomUUID(), "home:/docs/pending.bin", 0, digest(""));
    await entered.promise; const closed = f.fs.close(); release.release();
    await expect(pending).rejects.toMatchObject({ code: "daemon_unreachable" }); await closed;
    expect(await readdir(join(f.root, "docs"))).toEqual(["pending.bin"]);
    expect(await readFile(join(f.root, "docs/pending.bin"), "utf8")).toBe("baseline");
  } finally { release.release(); prototype.read = original; await f.close(); }
});

test("out-of-order cancellation during upload opening prevents the staging handle from being published", async () => {
  const entered = barrier(), release = barrier(), f = await fixture({ beforeUploadPublish: async () => { entered.release(); await release.promise; } });
  try {
    const id = randomUUID(), pending = f.fs.openUpload(id, "home:/docs/pending.bin", 0, digest(""));
    await entered.promise; expect(await f.fs.cancelUpload(id)).toEqual({ operationId: id, cancelled: false }); release.release();
    await expect(pending).rejects.toMatchObject({ code: "fs_upload_invalid" });
    expect(f.fs.mutationStatus(id).state).toBe("unknown"); expect(await readdir(join(f.root, "docs"))).toEqual([]);
  } finally { release.release(); await f.close(); }
});

test("ordered chunks, concurrent identical repeats and single commit preserve the original bytes", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), part = Buffer.alloc(FS_TRANSFER_CHUNK_BYTES, 0x31), bytes = Buffer.concat([part, part]);
    const opened = await Promise.all([f.fs.openUpload(id, "home:/docs/data.bin", bytes.length, digest(bytes)), f.fs.openUpload(id, "home:/docs/data.bin", bytes.length, digest(bytes))]);
    expect(opened[0]).toEqual(opened[1]);
    await expect(f.fs.uploadChunk(id, 1, part)).rejects.toMatchObject({ code: "fs_upload_invalid" });
    const repeats = await Promise.all([f.fs.uploadChunk(id, 0, part), f.fs.uploadChunk(id, 0, part)]);
    expect(repeats.map(r => r.repeated).sort()).toEqual([false, true]);
    await expect(f.fs.uploadChunk(id, 0, Buffer.alloc(part.length, 2))).rejects.toMatchObject({ code: "fs_upload_invalid" });
    await f.fs.uploadChunk(id, 1, part);
    const committed = await Promise.all([f.fs.commitUpload(id), f.fs.commitUpload(id)]); expect(committed[0]).toEqual(committed[1]);
    expect(await readFile(join(f.root, "docs/data.bin"))).toEqual(bytes);
    expect(f.fs.mutationStatus(id).state).toBe("committed");
    const other = randomUUID(), cross = await Promise.allSettled([f.fs.openUpload(other, "home:/docs/a", 0, digest("")), f.fs.openUpload(other, "home:/docs/b", 0, digest(""))]);
    expect(cross.map(r => r.status)).toEqual(["fulfilled", "rejected"]); await f.fs.cancelUpload(other);
  } finally { await f.close(); }
});

test("hash mismatch, exact size bound and cancellation-before-open never publish partial content", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); await f.fs.openUpload(id, "home:/docs/bad", 3, "0".repeat(64)); await f.fs.uploadChunk(id, 0, Buffer.from("abc"));
    await expect(f.fs.commitUpload(id)).rejects.toMatchObject({ code: "fs_hash_mismatch" }); expect(f.fs.mutationStatus(id).state).toBe("not_committed");
    const max = randomUUID(); expect(await f.fs.openUpload(max, "home:/docs/max", FS_UPLOAD_MAX_BYTES, "0".repeat(64))).toMatchObject({ size: FS_UPLOAD_MAX_BYTES });
    await f.fs.cancelUpload(max);
    await expect(f.fs.openUpload(randomUUID(), "home:/docs/oversize", FS_UPLOAD_MAX_BYTES + 1, "0".repeat(64))).rejects.toMatchObject({ code: "fs_upload_invalid" });
    const cancelled = randomUUID(); await f.fs.cancelUpload(cancelled);
    await expect(f.fs.openUpload(cancelled, "home:/docs/cancelled", 0, digest(""))).rejects.toMatchObject({ code: "fs_upload_invalid" });
    expect(await readdir(join(f.root, "docs"))).toEqual([]);
  } finally { await f.close(); }
});

test("trash reservation does not overwrite an older deletion and recursive removal rejects unsafe children", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); await writeFile(join(f.root, "docs/keep.txt"), "keep");
    await mkdir(join(f.root, ".grokbox-trash"), { mode: 0o700 }); await mkdir(join(f.root, ".grokbox-trash", id), { mode: 0o700 });
    await writeFile(join(f.root, ".grokbox-trash", id, "older.txt"), "older");
    await expect(f.fs.remove(id, "home:/docs/keep.txt", false)).rejects.toMatchObject({ code: "fs_conflict" });
    expect(await readFile(join(f.root, "docs/keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(f.root, ".grokbox-trash", id, "older.txt"), "utf8")).toBe("older");
    await expect(f.fs.remove(randomUUID(), "home:/docs", false)).rejects.toMatchObject({ code: "fs_not_empty" });
    await symlink(f.outside, join(f.root, "docs/escape"));
    await expect(f.fs.remove(randomUUID(), "home:/docs", true)).rejects.toBeDefined();
    expect((await stat(join(f.root, "docs"))).isDirectory()).toBe(true);
  } finally { await f.close(); }
});
