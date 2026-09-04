import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import { LocalDaemonClient } from "../src/daemon/client.ts";
import { validateDaemonConfig } from "../src/daemon/config.ts";
import {
  FS_DOWNLOAD_MAX_BYTES,
  FS_READ_MAX_BYTES,
  FS_TRANSFER_CHUNK_BYTES,
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

function errorCode(stderr: string): string {
  return (parseJson(stderr) as { error: { code: string } }).error.code;
}

afterEach(async () => {
  await host?.close().catch(() => undefined);
  gateway?.stop();
  host = undefined;
  gateway = undefined;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-fs-root-"));
  const outside = await mkdtemp(join(tmpdir(), "grokbox-fs-outside-"));
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-config-"));
  const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-download-"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, ".ssh"));
  await writeFile(join(root, "docs", "hello.txt"), "hello world\n");
  await writeFile(join(root, "docs", "binary.bin"), Buffer.from([0, 255, 1, 2]));
  await writeFile(join(root, "docs", "empty.bin"), Buffer.alloc(0));
  await writeFile(join(root, ".ssh", "id_ed25519"), "sensitive-marker-alpha");
  await writeFile(join(root, ".bashrc"), "sensitive-marker-beta");
  await writeFile(join(outside, "escape.txt"), "outside material");
  await symlink(join(outside, "escape.txt"), join(root, "escape.txt"));
  const chunked = Buffer.alloc(FS_TRANSFER_CHUNK_BYTES * 2 + 17, 0x5a);
  await writeFile(join(root, "docs", "chunked.bin"), chunked);

  gateway = await startMockGateway();
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const socketPath = join(configDir, "run", "daemon.sock");
  const token = "filesystem-shared-secret";
  host = await startDaemonHost(
    { ...createProductionDeps(), configDir, discoveryPath },
    socketPath,
    {
      host: "127.0.0.1",
      port: 0,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
    [{ name: "home", path: root, operations: ["stat", "list", "read", "download"] }],
  );
  await writeProfileFile(configDir, "local-daemon", {
    version: 1,
    transport: "daemon",
    daemon_socket: socketPath,
  });
  await writeProfileFile(configDir, "remote-daemon", {
    version: 1,
    transport: "daemon",
    server_url: `http://127.0.0.1:${host.network!.port}`,
    daemon_token_ref: "env:DAEMON_TOKEN",
  });
  await writeProfileFile(configDir, "auto-remote", {
    version: 1,
    transport: "auto",
    daemon_socket: join(configDir, "missing.sock"),
    gateway_discovery: discoveryPath,
    server_url: `http://127.0.0.1:${host.network!.port}`,
    daemon_token_ref: "env:DAEMON_TOKEN",
  });

  const run = async (profile: string, argv: string[]) => await captureCli(
    ["--profile", profile, ...argv],
    {
      configDir,
      discoveryPath,
      skillsDir,
      env: { DAEMON_TOKEN: token },
    },
  );
  return { root, configDir, destinationDir, socketPath, chunked, run };
}

describeLinux("governed filesystem reads", () => {
  test("handshake publishes only named roots and operations", async () => {
    const f = await fixture();
    const handshake = await new LocalDaemonClient(f.socketPath, 5_000).handshake();
    expect(handshake.capabilities).toContain("host.fs.read");
    expect(handshake.filesystemRoots).toEqual([{
      name: "home",
      operations: ["stat", "list", "read", "download"],
    }]);
    expect(JSON.stringify(handshake)).not.toContain(f.root);
  });

  test("stat, list, and text/binary reads are equivalent through local, remote, and capability-aware auto routing", async () => {
    const f = await fixture();
    for (const profile of ["local-daemon", "remote-daemon", "auto-remote"]) {
      const statResult = await f.run(profile, ["fs", "stat", "home:/docs/hello.txt"]);
      expect(statResult.code).toBe(0);
      const statBody = parseJson(statResult.stdout) as { data: { kind: string; size: number; sha256: string } };
      expect(statBody.data.kind).toBe("file");
      expect(statBody.data.size).toBe(12);
      expect(statBody.data.sha256).toBe(createHash("sha256").update("hello world\n").digest("hex"));

      const listResult = await f.run(profile, ["fs", "list", "home:/"]);
      expect(listResult.code).toBe(0);
      const names = (parseJson(listResult.stdout) as { data: { entries: Array<{ name: string }> } })
        .data.entries.map((entry) => entry.name);
      expect(names).toEqual(["docs"]);

      const textResult = await f.run(profile, ["fs", "read", "home:/docs/hello.txt"]);
      expect(textResult.code).toBe(0);
      expect((parseJson(textResult.stdout) as { data: { encoding: string; content: string } }).data).toMatchObject({
        encoding: "utf8",
        content: "hello world\n",
      });

      const binaryResult = await f.run(profile, ["fs", "read", "home:/docs/binary.bin"]);
      expect(binaryResult.code).toBe(0);
      expect((parseJson(binaryResult.stdout) as { data: { encoding: string; content: string } }).data).toMatchObject({
        encoding: "base64",
        content: Buffer.from([0, 255, 1, 2]).toString("base64"),
      });
    }
  });

  test("traversal, credential paths, symlink escape, invalid kinds, and byte overflow fail stably", async () => {
    const f = await fixture();
    const cases: Array<[string[], string]> = [
      [["fs", "read", "home:/../outside"], "fs_path_invalid"],
      [["fs", "read", `home:/${"a".repeat(256)}`], "fs_path_invalid"],
      [["fs", "read", "home:/.ssh/id_ed25519"], "fs_forbidden"],
      [["fs", "read", "home:/.bashrc"], "fs_forbidden"],
      [["fs", "read", "home:/escape.txt"], "fs_forbidden"],
      [["fs", "read", "home:/docs"], "fs_not_file"],
      [["fs", "list", "home:/docs/hello.txt"], "fs_not_directory"],
      [["fs", "read", "unknown:/file"], "fs_forbidden"],
    ];
    for (const [argv, expected] of cases) {
      const result = await f.run("local-daemon", argv);
      expect(result.code).not.toBe(0);
      expect(errorCode(result.stderr)).toBe(expected);
      expect(result.stderr).not.toContain("sensitive-marker-alpha");
      expect(result.stderr).not.toContain("sensitive-marker-beta");
      expect(result.stderr).not.toContain("outside material");
    }

    const largePath = join(f.root, "docs", "large.bin");
    await writeFile(largePath, Buffer.alloc(FS_READ_MAX_BYTES + 1));
    const large = await f.run("local-daemon", ["fs", "read", "home:/docs/large.bin"]);
    expect(large.code).toBe(40);
    expect(errorCode(large.stderr)).toBe("fs_too_large");

    const oversizedPath = join(f.root, "docs", "oversized.bin");
    const oversized = await open(oversizedPath, "w");
    await oversized.truncate(FS_DOWNLOAD_MAX_BYTES + 1);
    await oversized.close();
    const download = await f.run("local-daemon", [
      "fs",
      "download",
      "home:/docs/oversized.bin",
      join(f.destinationDir, "oversized.bin"),
    ]);
    expect(download.code).toBe(40);
    expect(errorCode(download.stderr)).toBe("fs_too_large");
  });

  test("download pins an authorized descriptor across pathname symlink replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-fs-descriptor-root-"));
    const outside = await mkdtemp(join(tmpdir(), "grokbox-fs-descriptor-outside-"));
    const authorizedPath = join(root, "race.txt");
    const originalPath = join(root, "race.original.txt");
    const outsidePath = join(outside, "credential.txt");
    await writeFile(authorizedPath, "authorized bytes");
    await writeFile(outsidePath, "outside bytes");
    const transferId = "11111111-1111-4111-8111-111111111111";
    const filesystem = await GovernedFilesystem.create(
      [{ name: "home", path: root, operations: ["download"] }],
      () => Date.now(),
    );
    const opened = await filesystem.openDownload("home:/race.txt", transferId);
    await rename(authorizedPath, originalPath);
    await symlink(outsidePath, authorizedPath);
    const chunk = await filesystem.downloadChunk(opened.transferId, 0);
    expect(Buffer.from(chunk.contentBase64, "base64").toString("utf8")).toBe("authorized bytes");
    expect(Buffer.from(chunk.contentBase64, "base64").toString("utf8")).not.toContain("outside bytes");
    expect((await filesystem.cancelDownload(opened.transferId)).cancelled).toBe(true);
    await filesystem.close();
  });

  test("pending and out-of-order cancellation prevent a transfer from being published", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-fs-pending-cancel-root-"));
    await writeFile(join(root, "pending.bin"), Buffer.alloc(FS_TRANSFER_CHUNK_BYTES, 7));
    const filesystem = await GovernedFilesystem.create(
      [{ name: "home", path: root, operations: ["download"] }],
      () => Date.now(),
    );

    const pendingId = "22222222-2222-4222-8222-222222222222";
    const pendingResult = filesystem.openDownload("home:/pending.bin", pendingId).catch((error) => error);
    expect((await filesystem.cancelDownload(pendingId)).cancelled).toBe(true);
    expect((await pendingResult).code).toBe("fs_transfer_invalid");
    await expect(filesystem.downloadChunk(pendingId, 0)).rejects.toMatchObject({ code: "fs_transfer_invalid" });

    const failedId = "66666666-6666-4666-8666-666666666666";
    await expect(filesystem.openDownload("home:/missing.bin", failedId)).rejects.toMatchObject({ code: "fs_not_found" });
    await writeFile(join(root, "missing.bin"), "now present");
    expect((await filesystem.openDownload("home:/missing.bin", failedId)).transferId).toBe(failedId);
    expect((await filesystem.cancelDownload(failedId)).cancelled).toBe(true);

    const reorderedId = "33333333-3333-4333-8333-333333333333";
    expect((await filesystem.cancelDownload(reorderedId)).cancelled).toBe(false);
    await expect(filesystem.openDownload("home:/pending.bin", reorderedId)).rejects.toMatchObject({
      code: "fs_transfer_invalid",
    });
    await filesystem.close();
  });

  test("cancellation during a pending hash is classified as an invalid transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-fs-hash-cancel-root-"));
    const path = join(root, "hashing.bin");
    await writeFile(path, "hash me");
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let enteredHash!: () => void;
    let releaseHash!: () => void;
    const entered = new Promise<void>((resolve) => { enteredHash = resolve; });
    const release = new Promise<void>((resolve) => { releaseHash = resolve; });
    prototype.read = (async function (this: typeof probe, ...args: unknown[]) {
      enteredHash();
      await release;
      return await originalRead.apply(this, args as never);
    }) as typeof probe.read;

    const filesystem = await GovernedFilesystem.create(
      [{ name: "home", path: root, operations: ["download"] }],
      () => Date.now(),
    );
    const transferId = "55555555-5555-4555-8555-555555555555";
    try {
      const opening = filesystem.openDownload("home:/hashing.bin", transferId).catch((error) => error);
      await entered;
      expect((await filesystem.cancelDownload(transferId)).cancelled).toBe(true);
      releaseHash();
      expect((await opening).code).toBe("fs_transfer_invalid");
      await expect(filesystem.downloadChunk(transferId, 0)).rejects.toMatchObject({ code: "fs_transfer_invalid" });
    } finally {
      releaseHash();
      prototype.read = originalRead;
      await filesystem.close();
    }
  });

  test("close drains a not-yet-published download open", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-fs-close-open-root-"));
    const path = join(root, "hashing.bin");
    await writeFile(path, "hash me during close");
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let enteredHash!: () => void;
    let releaseHash!: () => void;
    const entered = new Promise<void>((resolve) => { enteredHash = resolve; });
    const release = new Promise<void>((resolve) => { releaseHash = resolve; });
    prototype.read = (async function (this: typeof probe, ...args: unknown[]) {
      enteredHash();
      await release;
      return await originalRead.apply(this, args as never);
    }) as typeof probe.read;
    const filesystem = await GovernedFilesystem.create(
      [{ name: "home", path: root, operations: ["download"] }],
      Date.now,
    );
    const transferId = "78787878-7878-4878-8878-787878787878";
    try {
      const opening = filesystem.openDownload("home:/hashing.bin", transferId);
      await entered;
      const closing = filesystem.close();
      releaseHash();
      await expect(opening).rejects.toMatchObject({ code: "fs_transfer_invalid" });
      await closing;
      await expect(filesystem.downloadChunk(transferId, 0)).rejects.toMatchObject({ code: "fs_transfer_invalid" });
    } finally {
      releaseHash();
      prototype.read = originalRead;
      await filesystem.close();
    }
  });

  test("download chunks atomically, refuses overwrite, and verifies the SHA-256", async () => {
    const f = await fixture();
    for (const profile of ["local-daemon", "remote-daemon"]) {
      const destination = join(f.destinationDir, `${profile}.bin`);
      const result = await f.run(profile, ["fs", "download", "home:/docs/chunked.bin", destination]);
      expect(result.code).toBe(0);
      const body = parseJson(result.stdout) as { data: {
        remotePath: string;
        localPath: string;
        size: number;
        sha256: string;
        chunks: number;
        verified: boolean;
      } };
      expect(body.data).toEqual({
        remotePath: "home:/docs/chunked.bin",
        localPath: destination,
        size: f.chunked.length,
        sha256: createHash("sha256").update(f.chunked).digest("hex"),
        chunks: 3,
        verified: true,
      });
      expect(await readFile(destination)).toEqual(f.chunked);
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      const conflict = await f.run(profile, ["fs", "download", "home:/docs/chunked.bin", destination]);
      expect(conflict.code).toBe(43);
      expect(errorCode(conflict.stderr)).toBe("fs_destination_exists");
    }

    const emptyDestination = join(f.destinationDir, "empty.bin");
    const empty = await f.run("remote-daemon", ["fs", "download", "home:/docs/empty.bin", emptyDestination]);
    expect(empty.code).toBe(0);
    expect((parseJson(empty.stdout) as { data: { size: number; chunks: number; verified: boolean } }).data)
      .toMatchObject({ size: 0, chunks: 0, verified: true });
    expect(await readFile(emptyDestination)).toEqual(Buffer.alloc(0));
  });

  test("hash mismatch removes the partial destination and cancels the transfer", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-hash-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-hash-output-"));
    const destination = join(destinationDir, "bad.bin");
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    const result = await captureCli(["--profile", "remote", "fs", "download", "home:/bad.bin", destination], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      fetch: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        const transferId = String(request.params.transferId);
        if (request.method === "handshake") {
          return Response.json({ ok: true, result: {
            ...fakeHandshake,
            capabilities: ["host.fs.read"],
            filesystemRoots: [{ name: "home", operations: ["download"] }],
          } });
        }
        if (request.method === "fsDownloadOpen") {
          return Response.json({ ok: true, result: {
            transferId,
            path: "home:/bad.bin",
            root: "home",
            size: 3,
            sha256: "0".repeat(64),
            chunkBytes: FS_TRANSFER_CHUNK_BYTES,
            chunks: 1,
          } });
        }
        if (request.method === "fsDownloadChunk") {
          return Response.json({ ok: true, result: {
            transferId,
            index: 0,
            bytes: 3,
            contentBase64: Buffer.from("abc").toString("base64"),
            done: true,
          } });
        }
        return Response.json({ ok: true, result: { transferId, cancelled: true } });
      }) as typeof fetch,
    });
    expect(result.code).toBe(42);
    expect(errorCode(result.stderr)).toBe("fs_hash_mismatch");
    expect(methods.at(-1)).toBe("fsDownloadCancel");
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("no-clobber commit race preserves the competing destination and cancels", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-race-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-race-output-"));
    const destination = join(destinationDir, "race.bin");
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    const bytes = Buffer.from("abc");
    const result = await captureCli(["--profile", "remote", "fs", "download", "home:/race.bin", destination], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      fetch: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        const transferId = String(request.params.transferId);
        if (request.method === "handshake") {
          return Response.json({ ok: true, result: {
            ...fakeHandshake,
            capabilities: ["host.fs.read"],
            filesystemRoots: [{ name: "home", operations: ["download"] }],
          } });
        }
        if (request.method === "fsDownloadOpen") {
          return Response.json({ ok: true, result: {
            transferId,
            path: "home:/race.bin",
            root: "home",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            chunkBytes: FS_TRANSFER_CHUNK_BYTES,
            chunks: 1,
          } });
        }
        if (request.method === "fsDownloadChunk") {
          await writeFile(destination, "competing writer");
          return Response.json({ ok: true, result: {
            transferId,
            index: 0,
            bytes: bytes.length,
            contentBase64: bytes.toString("base64"),
            done: true,
          } });
        }
        return Response.json({ ok: true, result: { transferId, cancelled: true } });
      }) as typeof fetch,
    });
    expect(result.code).toBe(43);
    expect(errorCode(result.stderr)).toBe("fs_destination_exists");
    expect(await readFile(destination, "utf8")).toBe("competing writer");
    expect(methods.at(-1)).toBe("fsDownloadCancel");
    expect((await readdir(destinationDir)).filter((name) => name.includes(".grokbox-"))).toEqual([]);
  });

  test("signal cancellation aborts an in-flight chunk, removes the partial file, and cancels the transfer", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-cancel-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-cancel-output-"));
    const destination = join(destinationDir, "cancel.bin");
    const controller = new AbortController();
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    const result = await captureCli(["--profile", "remote", "fs", "download", "home:/cancel.bin", destination], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      signal: controller.signal,
      fetch: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        const transferId = String(request.params.transferId);
        if (request.method === "handshake") {
          return Response.json({ ok: true, result: {
            ...fakeHandshake,
            capabilities: ["host.fs.read"],
            filesystemRoots: [{ name: "home", operations: ["download"] }],
          } });
        }
        if (request.method === "fsDownloadOpen") {
          return Response.json({ ok: true, result: {
            transferId,
            path: "home:/cancel.bin",
            root: "home",
            size: 3,
            sha256: createHash("sha256").update("abc").digest("hex"),
            chunkBytes: FS_TRANSFER_CHUNK_BYTES,
            chunks: 1,
          } });
        }
        if (request.method === "fsDownloadChunk") {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
            signal?.addEventListener("abort", rejectAbort, { once: true });
            controller.abort();
            if (signal?.aborted) rejectAbort();
          });
        }
        return Response.json({ ok: true, result: { transferId, cancelled: true } });
      }) as typeof fetch,
    });
    expect(result.code).toBe(26);
    expect(errorCode(result.stderr)).toBe("daemon_unreachable");
    expect(methods).toContain("fsDownloadChunk");
    expect(methods.at(-1)).toBe("fsDownloadCancel");
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("signal cancellation can cancel an in-flight open by its client-allocated transfer identity", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-open-cancel-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-open-cancel-output-"));
    const destination = join(destinationDir, "cancel-open.bin");
    const controller = new AbortController();
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    let openedTransfer = "";
    let cancelledTransfer = "";
    const result = await captureCli(["--profile", "remote", "fs", "download", "home:/cancel-open.bin", destination], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      signal: controller.signal,
      fetch: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        if (request.method === "handshake") {
          return Response.json({ ok: true, result: {
            ...fakeHandshake,
            capabilities: ["host.fs.read"],
            filesystemRoots: [{ name: "home", operations: ["download"] }],
          } });
        }
        if (request.method === "fsDownloadOpen") {
          openedTransfer = String(request.params.transferId);
          return await new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
            init?.signal?.addEventListener("abort", rejectAbort, { once: true });
            controller.abort();
            if (init?.signal?.aborted) rejectAbort();
          });
        }
        cancelledTransfer = String(request.params.transferId);
        return Response.json({ ok: true, result: { transferId: cancelledTransfer, cancelled: true } });
      }) as typeof fetch,
    });
    expect(result.code).toBe(26);
    expect(methods).toEqual(["handshake", "fsDownloadOpen", "fsDownloadCancel"]);
    expect(cancelledTransfer).toBe(openedTransfer);
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("RPC timeout aborts an in-flight chunk and still performs bounded cleanup", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-timeout-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-timeout-output-"));
    const destination = join(destinationDir, "timeout.bin");
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const methods: string[] = [];
    const result = await captureCli([
      "--profile", "remote", "fs", "download", "home:/timeout.bin", destination, "--timeout-ms", "10",
    ], {
      configDir,
      skillsDir,
      env: { DAEMON_TOKEN: "secret" },
      fetch: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        methods.push(request.method);
        const transferId = String(request.params.transferId);
        if (request.method === "handshake") {
          return Response.json({ ok: true, result: {
            ...fakeHandshake,
            capabilities: ["host.fs.read"],
            filesystemRoots: [{ name: "home", operations: ["download"] }],
          } });
        }
        if (request.method === "fsDownloadOpen") {
          return Response.json({ ok: true, result: {
            transferId,
            path: "home:/timeout.bin",
            root: "home",
            size: 3,
            sha256: createHash("sha256").update("abc").digest("hex"),
            chunkBytes: FS_TRANSFER_CHUNK_BYTES,
            chunks: 1,
          } });
        }
        if (request.method === "fsDownloadChunk") {
          return await new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
            init?.signal?.addEventListener("abort", rejectAbort, { once: true });
            if (init?.signal?.aborted) rejectAbort();
          });
        }
        return Response.json({ ok: true, result: { transferId, cancelled: true } });
      }) as typeof fetch,
    });
    expect(result.code).toBe(26);
    expect(errorCode(result.stderr)).toBe("daemon_unreachable");
    expect(methods).toContain("fsDownloadChunk");
    expect(methods.at(-1)).toBe("fsDownloadCancel");
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("client rejects oversized transfer metadata and invalid read content before output", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-client-limit-config-"));
    const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-fs-client-limit-output-"));
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:12345",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "handshake") {
        return Response.json({ ok: true, result: {
          ...fakeHandshake,
          capabilities: ["host.fs.read"],
          filesystemRoots: [{ name: "home", operations: ["read", "download"] }],
        } });
      }
      if (request.method === "fsRead") {
        return Response.json({ ok: true, result: {
          path: "home:/bad.txt",
          root: "home",
          size: 3,
          sha256: "0".repeat(64),
          encoding: "utf8",
          content: "abc",
        } });
      }
      return Response.json({ ok: true, result: {
        transferId: "oversized",
        path: "home:/huge.bin",
        root: "home",
        size: FS_DOWNLOAD_MAX_BYTES + 1,
        sha256: "0".repeat(64),
        chunkBytes: FS_TRANSFER_CHUNK_BYTES,
        chunks: Math.ceil((FS_DOWNLOAD_MAX_BYTES + 1) / FS_TRANSFER_CHUNK_BYTES),
      } });
    }) as typeof fetch;
    const deps = { configDir, skillsDir, env: { DAEMON_TOKEN: "secret" }, fetch: fetchFn };
    const read = await captureCli(["--profile", "remote", "fs", "read", "home:/bad.txt"], deps);
    expect(read.code).toBe(42);
    expect(read.stdout).toBe("");
    expect(errorCode(read.stderr)).toBe("fs_hash_mismatch");

    const destination = join(destinationDir, "huge.bin");
    const download = await captureCli(
      ["--profile", "remote", "fs", "download", "home:/huge.bin", destination],
      deps,
    );
    expect(download.code).toBe(26);
    expect(download.stdout).toBe("");
    expect(errorCode(download.stderr)).toBe("daemon_unreachable");
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("Gateway-only Profiles reject filesystem use before Gateway or SSH access", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-fs-gateway-config-"));
    await writeProfileFile(configDir, "gateway", {
      version: 1,
      transport: "gateway",
      gateway_url: "https://gateway.example.test",
      gateway_token_ref: "env:GATEWAY_TOKEN",
      ssh_host: "box",
    });
    let fetches = 0;
    let commands = 0;
    const result = await captureCli(["--profile", "gateway", "fs", "stat", "home:/file"], {
      configDir,
      skillsDir,
      env: { GATEWAY_TOKEN: "secret" },
      fetch: (async () => {
        fetches += 1;
        throw new Error("unexpected");
      }) as unknown as typeof fetch,
      runCommand: async () => {
        commands += 1;
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(result.code).toBe(22);
    expect(errorCode(result.stderr)).toBe("capability_unavailable");
    expect(fetches).toBe(0);
    expect(commands).toBe(0);
  });

  test("daemon config rejects pseudo-filesystem roots and malformed policies", () => {
    expect(() => validateDaemonConfig({
      version: 1,
      filesystem: { roots: [{ name: "proc", path: "/proc", operations: ["read"] }] },
    })).toThrow();
    expect(() => validateDaemonConfig({
      version: 1,
      filesystem: { roots: [{ name: "home", path: "/home/box", operations: ["read", "read"] }] },
    })).toThrow();
  });
});
