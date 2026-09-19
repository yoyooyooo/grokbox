import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { acquireDaemonSocket, acquireServiceSocket } from "../src/internal/io/daemon-socket.node.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "daemon-socket-proof-")), socket = join(directory, "daemon.sock");
  return { directory, socket, close: () => rm(directory, { recursive: true, force: true }) };
}

test("unregistered ordinary files and symlinks cannot be reclaimed as stale sockets", async () => {
  const f = await fixture();
  try {
    await writeFile(f.socket, "USER_BYTES", { mode: 0o600 });
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toThrow("path_unqualified");
    expect(await readFile(f.socket, "utf8")).toBe("USER_BYTES");
    await rm(f.socket);
    const target = join(f.directory, "private.txt"); await writeFile(target, "PRIVATE_BYTES", { mode: 0o600 });
    await symlink(target, f.socket);
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toThrow("path_unqualified");
    expect(await readFile(target, "utf8")).toBe("PRIVATE_BYTES");
  } finally { await f.close(); }
});

test("a held listener gate excludes competing writers; normal close preserves the permanent gate identity", async () => {
  const f = await fixture(); let lease: Awaited<ReturnType<typeof acquireDaemonSocket>> | undefined;
  const server = createServer(socket => socket.end());
  try {
    lease = await acquireDaemonSocket(f.socket, randomUUID());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(f.socket, resolve); });
    await lease.recordBound();
    const gate = process.platform === "linux" ? await stat(`${f.socket}.gate`) : undefined;
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toBeDefined();
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await lease.release(); lease = undefined;
    if (gate) {
      expect((await stat(`${f.socket}.gate`)).ino).toBe(gate.ino);
      expect(JSON.parse(await readFile(`${f.socket}.owner.json`, "utf8")).state).toBe("stopped");
      expect(await readdir(f.directory)).not.toContain("daemon.sock.owner.json.next");
    }
    lease = await acquireDaemonSocket(f.socket, randomUUID());
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await lease?.release(); await f.close();
  }
});

test.skipIf(process.platform !== "linux")("malformed or redirected owner records block acquisition without rewriting user data", async () => {
  const f = await fixture();
  try {
    const owner = `${f.socket}.owner.json`;
    await writeFile(owner, "{INVALID_OWNER", { mode: 0o600 });
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toBeDefined();
    expect(await readFile(owner, "utf8")).toBe("{INVALID_OWNER");
    await rm(owner);
    const victim = join(f.directory, "owner-victim"); await writeFile(victim, "KEEP", { mode: 0o600 });
    await symlink(victim, owner);
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toThrow("owner_unqualified");
    expect(await readFile(victim, "utf8")).toBe("KEEP");
  } finally { await f.close(); }
});

test("modeld permits owner-only writable directories without changing permissions, while group-writable parents are refused", async () => {
  const f = await fixture();
  try {
    await chmod(f.directory, 0o755);
    await expect(acquireDaemonSocket(f.socket, randomUUID())).rejects.toThrow("directory_unqualified");
    const lease = await acquireServiceSocket(f.socket, randomUUID(), "owner-writable"); await lease.release();
    expect((await stat(f.directory)).mode & 0o777).toBe(0o755);
    await chmod(f.directory, 0o775);
    await expect(acquireServiceSocket(f.socket, randomUUID(), "owner-writable")).rejects.toThrow("directory_unqualified");
    expect((await stat(f.directory)).mode & 0o777).toBe(0o775);
  } finally { await f.close(); }
});

test("a symlinked socket parent cannot be made into a service installation", async () => {
  const f = await fixture();
  try {
    const target = join(f.directory, "user"), link = join(f.directory, "redirect");
    await mkdir(target, { mode: 0o700 }); await symlink(target, link);
    await expect(acquireDaemonSocket(join(link, "daemon.sock"), randomUUID())).rejects.toThrow("directory_unqualified");
    expect(await readdir(target)).toEqual([]);
  } finally { await f.close(); }
});
