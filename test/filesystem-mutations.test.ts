import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import { LocalDaemonClient } from "../src/daemon/client.ts";
import {
  FS_TRANSFER_CHUNK_BYTES,
  FS_UPLOAD_MAX_BYTES,
  GovernedFilesystem,
} from "../src/daemon/filesystem.ts";
import { startDaemonHost, type DaemonHost } from "../src/daemon/host.ts";
import { createProductionDeps } from "../src/deps.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery, type MockGateway } from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const describeLinux = process.platform === "linux" ? describe : describe.skip;
const fakeHandshake = {
  protocolMajor: 1,
  daemonVersion: "0.0.1",
  daemonPid: 1,
  startedAt: 1,
  daemonGeneration: "11111111-1111-4111-8111-111111111111",
  gateway: { pid: 1, startedAt: 1 },
};
let host: DaemonHost | undefined;
let gateway: MockGateway | undefined;

afterEach(async () => {
  await host?.close().catch(() => undefined);
  gateway?.stop();
  host = undefined;
  gateway = undefined;
});

function errorCode(stderr: string): string {
  return (parseJson(stderr) as { error: { code: string } }).error.code;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-fs-write-root-"));
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-write-config-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "existing.txt"), "before");
  gateway = await startMockGateway();
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const socketPath = join(configDir, "run", "daemon.sock");
  const token = "filesystem-write-secret";
  host = await startDaemonHost(
    { ...createProductionDeps(), configDir, discoveryPath },
    socketPath,
    {
      host: "127.0.0.1",
      port: 0,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
    [{
      name: "home",
      path: root,
      operations: [
        "stat", "list", "read", "download",
        "write", "mkdir", "upload", "remove", "remove-recursive",
      ],
    }],
  );
  await writeProfileFile(configDir, "local", { version: 1, transport: "daemon", daemon_socket: socketPath });
  await writeProfileFile(configDir, "remote", {
    version: 1,
    transport: "daemon",
    server_url: `http://127.0.0.1:${host.network!.port}`,
    daemon_token_ref: "env:DAEMON_TOKEN",
  });
  await writeProfileFile(configDir, "auto", {
    version: 1,
    transport: "auto",
    daemon_socket: join(configDir, "missing.sock"),
    gateway_discovery: discoveryPath,
    server_url: `http://127.0.0.1:${host.network!.port}`,
    daemon_token_ref: "env:DAEMON_TOKEN",
  });
  const run = async (profile: string, argv: string[], extra: Record<string, unknown> = {}) => await captureCli(
    ["--profile", profile, ...argv],
    { configDir, discoveryPath, skillsDir, env: { DAEMON_TOKEN: token }, ...extra },
  );
  return { root, configDir, discoveryPath, socketPath, run };
}

describeLinux("governed filesystem mutations", () => {
  test("handshake projects operation-aware write and recursive capabilities", async () => {
    const f = await fixture();
    const handshake = await new LocalDaemonClient(f.socketPath, 5_000).handshake();
    expect(handshake.capabilities).toContain("host.fs.write");
    expect(handshake.capabilities).toContain("host.fs.remove.recursive");
    expect(handshake.filesystemRoots[0]?.operations).toContain("upload");
    expect(JSON.stringify(handshake)).not.toContain(f.root);
  });

  test("daemon rejects malformed mutation params before destructive dispatch", async () => {
    const f = await fixture();
    const client = new LocalDaemonClient(f.socketPath, 5_000);
    const target = join(f.root, "docs", "existing.txt");
    const cases: Array<{ method: "fsWrite" | "fsRemove" | "fsUploadOpen"; params: Record<string, unknown> }> = [
      {
        method: "fsWrite",
        params: { operationId: "61616161-6161-4161-8161-616161616161", path: "home:/docs/existing.txt" },
      },
      {
        method: "fsWrite",
        params: {
          operationId: "62626262-6262-4262-8262-626262626262",
          path: "home:/docs/existing.txt",
          contentUtf8: "overwrite",
          expectedSha256: 42,
        },
      },
      {
        method: "fsRemove",
        params: {
          operationId: "63636363-6363-4363-8363-636363636363",
          path: "home:/docs/existing.txt",
          recursive: "false",
        },
      },
      {
        method: "fsUploadOpen",
        params: {
          operationId: "64646464-6464-4464-8464-646464646464",
          path: "home:/docs/upload.bin",
          size: 0,
          sha256: createHash("sha256").digest("hex"),
          unexpected: true,
        },
      },
    ];
    for (const item of cases) {
      await expect(client.call(item.method, item.params)).rejects.toMatchObject({ code: "gateway_bad_request" });
    }
    expect(await readFile(target, "utf8")).toBe("before");
    expect(await readdir(join(f.root, "docs"))).toEqual(["existing.txt"]);
  });

  test("explicit text suppresses stdin and write is atomic with expected-hash conflicts", async () => {
    const f = await fixture();
    let stdinReads = 0;
    for (const profile of ["local", "remote", "auto"]) {
      const target = `home:/docs/${profile}.txt`;
      const result = await f.run(profile, ["fs", "write", target, "--text", "explicit"], {
        stdinIsTTY: false,
        readStdin: async () => { stdinReads += 1; return "wrong"; },
      });
      expect(result.code).toBe(0);
      expect(await readFile(join(f.root, "docs", `${profile}.txt`), "utf8")).toBe("explicit");
    }
    expect(stdinReads).toBe(0);
    const missing = await f.run("local", ["fs", "write", "home:/docs/missing-input.txt"], {
      stdinIsTTY: true,
    });
    expect(missing.code).toBe(2);

    const existing = join(f.root, "docs", "existing.txt");
    const expected = createHash("sha256").update("before").digest("hex");
    const replaced = await f.run("local", [
      "fs", "write", "home:/docs/existing.txt", "--text", "after", "--expected-sha256", expected,
    ]);
    expect(replaced.code).toBe(0);
    const conflict = await f.run("local", [
      "fs", "write", "home:/docs/existing.txt", "--text", "lost", "--expected-sha256", expected,
    ]);
    expect(conflict.code).toBe(44);
    expect(errorCode(conflict.stderr)).toBe("fs_conflict");
    expect(await readFile(existing, "utf8")).toBe("after");
    const blocked = await f.run("local", ["fs", "write", "home:/.ssh/private", "--text", "secret"]);
    expect(blocked.code).toBe(36);
    expect((await readdir(join(f.root, "docs"))).filter((name) => name.includes(".grokbox-write-"))).toEqual([]);
  });

  test("stdin write, mkdir, zero-byte upload, and multi-chunk upload preserve exact bytes", async () => {
    const f = await fixture();
    const stdin = await f.run("local", ["fs", "write", "home:/docs/stdin.txt"], {
      stdinIsTTY: false,
      readStdin: async () => "stdin\n",
    });
    expect(stdin.code).toBe(0);
    expect(await readFile(join(f.root, "docs", "stdin.txt"), "utf8")).toBe("stdin\n");

    expect((await f.run("local", ["fs", "mkdir", "home:/created"])).code).toBe(0);
    expect((await stat(join(f.root, "created"))).isDirectory()).toBe(true);

    const localDir = await mkdtemp(join(tmpdir(), "grokbox-upload-source-"));
    const empty = join(localDir, "empty.bin");
    const chunked = join(localDir, "chunked.bin");
    await writeFile(empty, "");
    const bytes = Buffer.alloc(FS_TRANSFER_CHUNK_BYTES * 2 + 7, 0x6b);
    await writeFile(chunked, bytes);
    expect((await f.run("remote", ["fs", "upload", empty, "home:/docs/empty.bin"])).code).toBe(0);
    expect((await f.run("remote", ["fs", "upload", chunked, "home:/docs/chunked.bin"])).code).toBe(0);
    expect(await readFile(join(f.root, "docs", "empty.bin"))).toEqual(Buffer.alloc(0));
    expect(await readFile(join(f.root, "docs", "chunked.bin"))).toEqual(bytes);
    expect((await readdir(join(f.root, "docs"))).filter((name) => name.includes(".grokbox-upload-"))).toEqual([]);
  });

  test("upload accepts legal short positional reads without changing bytes", async () => {
    const f = await fixture();
    const localDir = await mkdtemp(join(tmpdir(), "grokbox-upload-short-read-"));
    const source = join(localDir, "source.bin");
    const content = Buffer.alloc(FS_TRANSFER_CHUNK_BYTES + 17, 0x5a);
    await writeFile(source, content);
    const probe = await open(source, "r");
    type TestRead = (
      this: typeof probe,
      buffer: Buffer,
      offset?: number | null,
      length?: number | null,
      position?: number | bigint | null,
    ) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const prototype = Object.getPrototypeOf(probe) as { read: TestRead };
    const originalRead = prototype.read;
    await probe.close();
    prototype.read = async function (this: typeof probe, buffer, offset, length, position) {
      const requested = length ?? buffer.length;
      return await originalRead.call(this, buffer, offset, Math.max(1, Math.floor(requested / 2)), position);
    };
    try {
      const result = await f.run("local", ["fs", "upload", source, "home:/docs/short-read.bin"]);
      expect(result.code).toBe(0);
      expect(await readFile(join(f.root, "docs", "short-read.bin"))).toEqual(content);
    } finally {
      prototype.read = originalRead;
    }
  });

  test("write keeps the authorized parent descriptor across parent-path replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-write-parent-root-"));
    const outside = await mkdtemp(join(tmpdir(), "grokbox-write-parent-outside-"));
    await mkdir(join(root, "docs"));
    const probe = await open(join(root, "docs"), "r");
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    let enteredSync!: () => void;
    let releaseSync!: () => void;
    const entered = new Promise<void>((resolve) => { enteredSync = resolve; });
    const release = new Promise<void>((resolve) => { releaseSync = resolve; });
    let first = true;
    prototype.sync = async function (this: typeof probe) {
      if (first) {
        first = false;
        enteredSync();
        await release;
      }
      return await originalSync.call(this);
    };
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["write"] },
    ], Date.now);
    try {
      const writing = filesystem.write(
        "99999999-9999-4999-8999-999999999999",
        "home:/docs/value.txt",
        Buffer.from("authorized"),
      );
      await entered;
      await rename(join(root, "docs"), join(root, "docs-original"));
      await symlink(outside, join(root, "docs"));
      releaseSync();
      expect(await writing).toMatchObject({ state: "committed" });
      expect(await filesystem.write(
        "99999999-9999-4999-8999-999999999999",
        "home:/docs/value.txt",
        Buffer.from("authorized"),
      )).toMatchObject({ state: "committed" });
      await expect(filesystem.write(
        "99999999-9999-4999-8999-999999999999",
        "home:/docs/value.txt",
        Buffer.from("different"),
      )).rejects.toMatchObject({ code: "fs_conflict" });
      expect(await readFile(join(root, "docs-original", "value.txt"), "utf8")).toBe("authorized");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      releaseSync();
      prototype.sync = originalSync;
      await filesystem.close();
    }
  });

  test("in-root parent rename preserves physical target serialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-write-lock-identity-root-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "value.txt"), "before");
    const probe = await open(join(root, "docs"), "r");
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    let enteredSync!: () => void;
    let releaseSync!: () => void;
    const entered = new Promise<void>((resolve) => { enteredSync = resolve; });
    const release = new Promise<void>((resolve) => { releaseSync = resolve; });
    let first = true;
    prototype.sync = async function (this: typeof probe) {
      if (first) {
        first = false;
        enteredSync();
        await release;
      }
      return await originalSync.call(this);
    };
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["write"] },
    ], Date.now);
    const expected = createHash("sha256").update("before").digest("hex");
    try {
      const firstWrite = filesystem.write(
        "56565656-5656-4656-8656-565656565656",
        "home:/docs/value.txt",
        Buffer.from("first"),
        expected,
      );
      await entered;
      await rename(join(root, "docs"), join(root, "docs-original"));
      const secondWrite = filesystem.write(
        "57575757-5757-4757-8757-575757575757",
        "home:/docs-original/value.txt",
        Buffer.from("second"),
        expected,
      );
      releaseSync();
      await expect(firstWrite).resolves.toMatchObject({ state: "committed" });
      await expect(secondWrite).rejects.toMatchObject({ code: "fs_conflict" });
      expect(await readFile(join(root, "docs-original", "value.txt"), "utf8")).toBe("first");
    } finally {
      releaseSync();
      prototype.sync = originalSync;
      await filesystem.close();
    }
  });

  test("write rejects a pinned parent relocated outside its admitted root", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-write-relocate-root-"));
    const outside = await mkdtemp(join(tmpdir(), "grokbox-write-relocate-outside-"));
    await mkdir(join(root, "docs"));
    const probe = await open(join(root, "docs"), "r");
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    let enteredSync!: () => void;
    let releaseSync!: () => void;
    const entered = new Promise<void>((resolve) => { enteredSync = resolve; });
    const release = new Promise<void>((resolve) => { releaseSync = resolve; });
    let first = true;
    prototype.sync = async function (this: typeof probe) {
      if (first) {
        first = false;
        enteredSync();
        await release;
      }
      return await originalSync.call(this);
    };
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["write"] },
    ], Date.now);
    try {
      const writing = filesystem.write(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "home:/docs/value.txt",
        Buffer.from("must not escape"),
      );
      await entered;
      await rename(join(root, "docs"), join(outside, "relocated"));
      releaseSync();
      await expect(writing).rejects.toMatchObject({ code: "fs_forbidden" });
      expect(await readdir(join(outside, "relocated"))).toEqual([]);
    } finally {
      releaseSync();
      prototype.sync = originalSync;
      await filesystem.close();
    }
  });

  test("close drains pending upload admission without publishing resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-upload-close-root-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "pending.bin"), "baseline");
    const probe = await open(join(root, "docs", "pending.bin"), "r");
    type TestRead = (
      this: typeof probe,
      buffer: Buffer,
      offset?: number | null,
      length?: number | null,
      position?: number | bigint | null,
    ) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const prototype = Object.getPrototypeOf(probe) as { read: TestRead };
    const originalRead = prototype.read;
    await probe.close();
    let enteredRead!: () => void;
    let releaseRead!: () => void;
    const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let first = true;
    prototype.read = async function (this: typeof probe, buffer, offset, length, position) {
      if (first) {
        first = false;
        enteredRead();
        await release;
      }
      return await originalRead.call(this, buffer, offset, length, position);
    };
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["upload"] },
    ], Date.now);
    try {
      const opening = filesystem.openUpload(
        "12121212-1212-4212-8212-121212121212",
        "home:/docs/pending.bin",
        0,
        createHash("sha256").digest("hex"),
      );
      await entered;
      const closing = filesystem.close();
      releaseRead();
      await expect(opening).rejects.toMatchObject({ code: "daemon_unreachable" });
      await closing;
      expect((await readdir(join(root, "docs"))).filter((name) => name.startsWith(".grokbox-upload-"))).toEqual([]);
    } finally {
      releaseRead();
      prototype.read = originalRead;
      await filesystem.close();
    }
  });

  test("cancellation during final upload verification prevents publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-upload-publish-cancel-root-"));
    await mkdir(join(root, "docs"));
    const operationId = "34343434-3434-4434-8434-343434343434";
    let enteredPublish!: () => void;
    let releasePublish!: () => void;
    const entered = new Promise<void>((resolve) => { enteredPublish = resolve; });
    const release = new Promise<void>((resolve) => { releasePublish = resolve; });
    const filesystem = await GovernedFilesystem.create(
      [{ name: "home", path: root, operations: ["upload"] }],
      Date.now,
      { beforeUploadPublish: async () => { enteredPublish(); await release; } },
    );
    try {
      const opening = filesystem.openUpload(
        operationId,
        "home:/docs/pending.bin",
        0,
        createHash("sha256").digest("hex"),
      );
      await entered;
      expect(await filesystem.cancelUpload(operationId)).toEqual({ operationId, cancelled: false });
      releasePublish();
      await expect(opening).rejects.toMatchObject({ code: "fs_upload_invalid" });
      expect(filesystem.mutationStatus(operationId)).toEqual({ operationId, state: "unknown" });
      expect((await readdir(join(root, "docs"))).filter((name) => name.includes(operationId))).toEqual([]);
    } finally {
      releasePublish();
      await filesystem.close();
    }
  });

  test("upload chunks are ordered, idempotent only for identical bytes, and cancellable before open", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-upload-state-root-"));
    await mkdir(join(root, "docs"));
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["upload"] },
    ], Date.now);
    const operationId = "77777777-7777-4777-8777-777777777777";
    const bytes = Buffer.from("abc");
    await filesystem.openUpload(
      operationId,
      "home:/docs/value.bin",
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
    );
    await expect(filesystem.uploadChunk(operationId, 1, bytes)).rejects.toMatchObject({ code: "fs_upload_invalid" });
    expect(await filesystem.uploadChunk(operationId, 0, bytes)).toMatchObject({ repeated: false });
    expect(await filesystem.uploadChunk(operationId, 0, bytes)).toMatchObject({ repeated: true });
    await expect(filesystem.uploadChunk(operationId, 0, Buffer.from("xyz"))).rejects.toMatchObject({
      code: "fs_upload_invalid",
    });
    expect(await filesystem.commitUpload(operationId)).toMatchObject({ state: "committed" });
    expect(await readFile(join(root, "docs", "value.bin"))).toEqual(bytes);

    const concurrentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const part = Buffer.alloc(FS_TRANSFER_CHUNK_BYTES, 0x31);
    const concurrentHash = createHash("sha256").update(part).update(part).digest("hex");
    const [firstOpen, secondOpen] = await Promise.all([
      filesystem.openUpload(concurrentId, "home:/docs/concurrent.bin", part.length * 2, concurrentHash),
      filesystem.openUpload(concurrentId, "home:/docs/concurrent.bin", part.length * 2, concurrentHash),
    ]);
    expect(firstOpen).toEqual(secondOpen);
    const duplicateResults = await Promise.all([
      filesystem.uploadChunk(concurrentId, 0, part),
      filesystem.uploadChunk(concurrentId, 0, part),
    ]);
    expect(duplicateResults.map((result) => result.repeated).sort()).toEqual([false, true]);
    await filesystem.uploadChunk(concurrentId, 1, part);
    const [firstCommit, secondCommit] = await Promise.all([
      filesystem.commitUpload(concurrentId),
      filesystem.commitUpload(concurrentId),
    ]);
    expect(firstCommit).toEqual(secondCommit);
    expect(firstCommit).toMatchObject({ state: "committed" });
    expect(filesystem.mutationStatus(concurrentId)).toMatchObject({ state: "committed" });
    expect((await stat(join(root, "docs", "concurrent.bin"))).size).toBe(part.length * 2);

    const crossTargetId = "abababab-abab-4bab-8bab-abababababab";
    const emptySha256 = createHash("sha256").digest("hex");
    const [firstTarget, secondTarget] = await Promise.allSettled([
      filesystem.openUpload(crossTargetId, "home:/docs/first.bin", 0, emptySha256),
      filesystem.openUpload(crossTargetId, "home:/docs/second.bin", 0, emptySha256),
    ]);
    expect(firstTarget.status).toBe("fulfilled");
    expect(secondTarget.status).toBe("rejected");
    if (secondTarget.status === "rejected") expect(secondTarget.reason).toMatchObject({ code: "fs_conflict" });
    await filesystem.cancelUpload(crossTargetId);
    expect((await readdir(join(root, "docs"))).filter((name) => name.includes(crossTargetId))).toEqual([]);

    const mismatchId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await filesystem.openUpload(mismatchId, "home:/docs/mismatch.bin", bytes.length, "0".repeat(64));
    await filesystem.uploadChunk(mismatchId, 0, bytes);
    await expect(filesystem.commitUpload(mismatchId)).rejects.toMatchObject({ code: "fs_hash_mismatch" });
    expect(filesystem.mutationStatus(mismatchId)).toMatchObject({ state: "not_committed" });
    expect((await readdir(join(root, "docs"))).some((name) => name.includes(mismatchId))).toBe(false);

    const boundaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(await filesystem.openUpload(
      boundaryId,
      "home:/docs/boundary.bin",
      FS_UPLOAD_MAX_BYTES,
      "0".repeat(64),
    )).toMatchObject({ size: FS_UPLOAD_MAX_BYTES });
    expect((await filesystem.cancelUpload(boundaryId)).cancelled).toBe(true);
    await expect(filesystem.openUpload(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "home:/docs/oversized.bin",
      FS_UPLOAD_MAX_BYTES + 1,
      "0".repeat(64),
    )).rejects.toMatchObject({ code: "fs_upload_invalid" });

    const cancelledId = "88888888-8888-4888-8888-888888888888";
    expect((await filesystem.cancelUpload(cancelledId)).cancelled).toBe(false);
    await expect(filesystem.openUpload(
      cancelledId,
      "home:/docs/cancelled.bin",
      0,
      createHash("sha256").update("").digest("hex"),
    )).rejects.toMatchObject({ code: "fs_upload_invalid" });
    await filesystem.close();
  });

  test("recoverable trash reservation is atomic no-clobber", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-trash-collision-root-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "keep.txt"), "keep");
    const operationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await mkdir(join(root, ".grokbox-trash"));
    await mkdir(join(root, ".grokbox-trash", operationId));
    await writeFile(join(root, ".grokbox-trash", operationId, "older.txt"), "older");
    const filesystem = await GovernedFilesystem.create([
      { name: "home", path: root, operations: ["remove"] },
    ], Date.now);
    await expect(filesystem.remove(operationId, "home:/docs/keep.txt", false)).rejects.toMatchObject({
      code: "fs_conflict",
    });
    expect(await readFile(join(root, "docs", "keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(root, ".grokbox-trash", operationId, "older.txt"), "utf8")).toBe("older");
    await filesystem.close();
  });

  test("remove returns opaque recoverable trash identity and recursive policy is enforced", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "docs", "confirm.txt"), "keep");
    const declined = await f.run("local", ["fs", "remove", "home:/docs/confirm.txt"], {
      stdinIsTTY: true,
      confirm: async () => false,
    });
    expect(declined.code).toBe(2);
    expect(await readFile(join(f.root, "docs", "confirm.txt"), "utf8")).toBe("keep");

    await writeFile(join(f.root, "docs", "trash.txt"), "trash me");
    const removed = await f.run("local", ["fs", "remove", "home:/docs/trash.txt", "--yes"]);
    expect(removed.code).toBe(0);
    const data = (parseJson(removed.stdout) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ recoverable: true, kind: "file" });
    expect(JSON.stringify(data)).not.toContain(f.root);
    const trashPath = join(f.root, ".grokbox-trash");
    expect(await readdir(trashPath)).toHaveLength(1);
    expect((await stat(trashPath)).mode & 0o777).toBe(0o700);

    await mkdir(join(f.root, "tree"));
    await writeFile(join(f.root, "tree", "child.txt"), "child");
    const nonRecursive = await f.run("local", ["fs", "remove", "home:/tree", "--yes"]);
    expect(nonRecursive.code).toBe(45);
    expect(errorCode(nonRecursive.stderr)).toBe("fs_not_empty");
    const recursive = await f.run("local", ["fs", "remove", "home:/tree", "--recursive", "--yes"]);
    expect(recursive.code).toBe(0);

    await mkdir(join(f.root, "blocked"));
    await mkdir(join(f.root, "blocked", ".ssh"));
    await writeFile(join(f.root, "blocked", ".ssh", "id"), "secret");
    const blocked = await f.run("local", ["fs", "remove", "home:/blocked", "--recursive", "--yes"]);
    expect(blocked.code).toBe(36);
    expect(errorCode(blocked.stderr)).toBe("fs_forbidden");
  });

  test("upload signal aborts an in-flight chunk and issues independent cancellation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-upload-cancel-config-"));
    const localDir = await mkdtemp(join(tmpdir(), "grokbox-fs-upload-cancel-source-"));
    const source = join(localDir, "source.bin");
    await writeFile(source, "abc");
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const controller = new AbortController();
    const methods: string[] = [];
    const result = await captureCli([
      "--profile", "remote", "fs", "upload", source, "home:/source.bin",
    ], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      signal: controller.signal,
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        const operationId = String(request.params.operationId);
        if (request.method === "handshake") return Response.json({ ok: true, result: {
          ...fakeHandshake,
          capabilities: ["host.fs.write"],
          filesystemRoots: [{ name: "home", operations: ["upload"] }],
        } });
        if (request.method === "fsUploadOpen") return Response.json({ ok: true, result: {
          operationId,
          path: "home:/source.bin",
          size: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
          chunkBytes: FS_TRANSFER_CHUNK_BYTES,
          chunks: 1,
        } });
        if (request.method === "fsUploadChunk") {
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            init?.signal?.addEventListener("abort", abort, { once: true });
            controller.abort();
            if (init?.signal?.aborted) abort();
          });
        }
        return Response.json({ ok: true, result: { operationId, cancelled: true } });
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(26);
    expect(methods).toContain("fsUploadChunk");
    expect(methods).not.toContain("fsUploadCommit");
    expect(methods.at(-1)).toBe("fsUploadCancel");
  });

  test("lost mutation response reconciles committed state without replay", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-reconcile-config-"));
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    let operationId = "";
    const result = await captureCli([
      "--profile", "remote", "fs", "write", "home:/result.txt", "--text", "content",
    ], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        if (request.method === "handshake") return Response.json({ ok: true, result: {
          ...fakeHandshake,
          capabilities: ["host.fs.write"],
          filesystemRoots: [{ name: "home", operations: ["write"] }],
        } });
        if (request.method === "fsWrite") {
          operationId = String(request.params.operationId);
          return new Response(new ReadableStream({
            pull(controller) { controller.error(new Error("response body reset after commit")); },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return Response.json({ ok: true, result: {
          operationId,
          state: "committed",
          result: {
            operationId,
            state: "committed",
            path: "home:/result.txt",
            size: 7,
            sha256: createHash("sha256").update("content").digest("hex"),
            replaced: false,
          },
        } });
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(0);
    expect(methods.filter((method) => method === "fsWrite")).toHaveLength(1);
    expect(methods.at(-1)).toBe("fsMutationStatus");
  });

  test("Gateway-only rejection happens before stdin and local upload file access", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-write-gateway-"));
    await writeProfileFile(configDir, "gateway", {
      version: 1,
      transport: "gateway",
      gateway_url: "https://gateway.example.test",
      gateway_token_ref: "env:GATEWAY_TOKEN",
    });
    let stdinReads = 0;
    let fetches = 0;
    const deps = {
      configDir,
      skillsDir,
      env: { GATEWAY_TOKEN: "secret" },
      stdinIsTTY: false,
      readStdin: async () => { stdinReads += 1; return "payload"; },
      fetch: (async () => { fetches += 1; throw new Error("unexpected"); }) as unknown as typeof fetch,
    };
    const write = await captureCli(["--profile", "gateway", "fs", "write", "home:/x"], deps);
    const upload = await captureCli(["--profile", "gateway", "fs", "upload", "/missing/private", "home:/x"], deps);
    expect(errorCode(write.stderr)).toBe("capability_unavailable");
    expect(errorCode(upload.stderr)).toBe("capability_unavailable");
    expect(stdinReads).toBe(0);
    expect(fetches).toBe(0);
  });
});
