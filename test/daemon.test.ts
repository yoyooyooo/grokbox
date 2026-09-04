import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile, writeProtectedSecret } from "../src/config/profile.ts";
import {
  bootstrapPeerDaemon,
  ownedMappingProbeCommand,
  remoteFilesystemPolicyMergeCommand,
  remoteInstallCommand,
  remoteEnsureInstalledDaemonCommand,
  remotePackageIntegrityCommand,
  remotePrepareRollbackCommand,
  remoteRollbackCommand,
} from "../src/bootstrap.ts";
import { readDaemonConfig, writeDaemonConfig } from "../src/daemon/config.ts";
import { LocalDaemonClient, RemoteDaemonClient } from "../src/daemon/client.ts";
import { startDaemonHost, type DaemonHost } from "../src/daemon/host.ts";
import { DAEMON_PROTOCOL_MAJOR } from "../src/daemon/protocol.ts";
import { createProductionDeps } from "../src/deps.ts";
import {
  captureCli,
  parseJson,
  rpcCalls,
  startMockGateway,
  writeDiscovery,
  type MockGateway,
} from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: DaemonHost | undefined;
let gateway: MockGateway | undefined;

afterEach(async () => {
  await host?.close().catch(() => undefined);
  gateway?.stop();
  host = undefined;
  gateway = undefined;
});

async function fixture() {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-daemon-test-"));
  const socket = join(configDir, "run", "daemon.sock");
  gateway = await startMockGateway();
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const deps = {
    ...createProductionDeps(),
    configDir,
    env: {},
    discoveryPath,
    daemonSocket: socket,
    transport: "local" as const,
  };
  host = await startDaemonHost(deps, socket);
  await writeProfileFile(configDir, "daemon", {
    version: 1,
    transport: "daemon",
    daemon_socket: socket,
    gateway_discovery: discoveryPath,
  });
  const run = async (argv: string[]) =>
    await captureCli(argv, {
      configDir,
      env: {},
      discoveryPath: "/must-not-be-used-directly.json",
      daemonSocket: socket,
      transport: "auto",
      skillsDir,
      stdinIsTTY: true,
      readStdin: async () => "",
      randomUUID: () => nonce,
    });
  return { configDir, discoveryPath, socket, deps, run };
}

async function rawRpc(socketPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const serialized = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1/rpc",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(serialized);
  });
}

async function unauthorizedBeforeBody(port: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/v1/rpc",
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    }, (res) => {
      res.resume();
      res.on("end", () => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("unauthorized daemon waited for request body"));
    }, 1_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.flushHeaders();
  });
}

describe("local daemon vertical slice", () => {
  test("generated remote install script is valid POSIX shell", async () => {
    const scripts = [
      remoteInstallCommand("test", "0".repeat(64)),
      remoteEnsureInstalledDaemonCommand(),
      remotePrepareRollbackCommand("abc123"),
      remoteRollbackCommand("abc123"),
    ];
    for (const script of scripts) {
      const proc = Bun.spawn(["sh", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write(script);
      proc.stdin.end();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      expect(script).not.toContain("&;");
      expect(script).not.toContain("tailscale serve reset");
    }
    const rollback = remoteRollbackCommand("abc123");
    expect(rollback).toContain('[ ! -S "$HOME/.grokbox/run/daemon.sock" ]');
    expect(rollback).toContain('kill -0 "$daemon_pid"');
    expect(rollback).toContain("daemon status >/dev/null");

    const integrityTrash = process.platform === "darwin"
      ? join(homedir(), ".Trash")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
    await mkdir(integrityTrash, { recursive: true });
    const integrityHome = await mkdtemp(join(integrityTrash, "grokbox-integrity-test-"));
    const bootstrapDir = join(integrityHome, ".grokbox", "bootstrap");
    await mkdir(bootstrapDir, { recursive: true });
    const packageBytes = Buffer.from("packed-runtime");
    await writeFile(join(bootstrapDir, "package.tgz"), packageBytes);
    const expectedHash = createHash("sha256").update(packageBytes).digest("hex");
    const matching = Bun.spawn(["sh", "-c", remotePackageIntegrityCommand(expectedHash)], {
      env: { ...process.env, HOME: integrityHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await matching.exited).toBe(0);
    const mismatch = Bun.spawn(["sh", "-c", remotePackageIntegrityCommand("0".repeat(64))], {
      env: { ...process.env, HOME: integrityHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await mismatch.exited).toBe(1);
    expect(() => remotePackageIntegrityCommand("not-a-digest")).toThrow();
  });

  test("remote bootstrap preserves narrow roots and adds home only on explicit policy admission", async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), "grokbox-policy-merge-test-"));
    await mkdir(join(remoteHome, ".grokbox", "daemon"), { recursive: true });
    await mkdir(join(remoteHome, ".grokbox", "bootstrap"), { recursive: true });
    const prior = {
      version: 1,
      filesystem: {
        roots: [{ name: "workspace", path: "/workspace/project", operations: ["stat", "read", "write", "upload"] }],
      },
    };
    const staged = {
      version: 1,
      filesystem: {
        roots: [{ name: "home", path: "/home/box", operations: ["stat", "list", "read", "download"] }],
      },
    };
    await writeFile(join(remoteHome, ".grokbox", "daemon", "config.json"), JSON.stringify(prior));
    const stagedPath = join(remoteHome, ".grokbox", "bootstrap", "daemon-config.json");
    await writeFile(stagedPath, JSON.stringify(staged));
    const merge = Bun.spawn(["sh", "-c", remoteFilesystemPolicyMergeCommand()], {
      env: { ...process.env, HOME: remoteHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await merge.exited).toBe(0);
    expect(JSON.parse(await readFile(stagedPath, "utf8")).filesystem.roots).toEqual([
      prior.filesystem.roots[0],
      staged.filesystem.roots[0],
    ]);

    const priorHome = {
      ...prior,
      filesystem: {
        roots: [
          prior.filesystem.roots[0],
          { name: "home", path: "/home/box/project", operations: ["stat", "write", "upload"] },
        ],
      },
    };
    await writeFile(join(remoteHome, ".grokbox", "daemon", "config.json"), JSON.stringify(priorHome));
    await writeFile(stagedPath, JSON.stringify(staged));
    const explicit = Bun.spawn(["sh", "-c", remoteFilesystemPolicyMergeCommand()], {
      env: { ...process.env, HOME: remoteHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await explicit.exited).toBe(0);
    expect(JSON.parse(await readFile(stagedPath, "utf8")).filesystem.roots).toEqual([
      prior.filesystem.roots[0],
      {
        ...staged.filesystem.roots[0],
        operations: ["stat", "write", "upload", "list", "read", "download"],
      },
    ]);

    await writeFile(join(remoteHome, ".grokbox", "daemon", "config.json"), JSON.stringify(prior));
    await writeFile(stagedPath, JSON.stringify({ version: 1 }));
    const preserve = Bun.spawn(["sh", "-c", remoteFilesystemPolicyMergeCommand()], {
      env: { ...process.env, HOME: remoteHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await preserve.exited).toBe(0);
    expect(JSON.parse(await readFile(stagedPath, "utf8")).filesystem.roots).toEqual(prior.filesystem.roots);
  });

  test("bootstrap rejects a transferred digest mismatch before daemon or Serve mutation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-bootstrap-integrity-test-"));
    const commands: string[][] = [];
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      randomUUID: () => nonce,
      runCommand: async (argv: readonly string[]) => {
        commands.push([...argv]);
        const command = argv.at(-1) ?? "";
        if (argv[0] === "npm") {
          const destination = argv[argv.indexOf("--pack-destination") + 1]!;
          await writeFile(join(destination, "grokbox-0.0.1.tgz"), "package");
          return { code: 0, stdout: "grokbox-0.0.1.tgz\n", stderr: "" };
        }
        if (command === "sudo -n tailscale serve status --json") {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (command.includes("crypto.createHash('sha256')")) {
          return { code: 1, stdout: "", stderr: "digest mismatch" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(bootstrapPeerDaemon(
      deps,
      "remote",
      { name: "box", dnsName: "box.example.ts.net", ipv4: "192.0.2.20" },
      "box",
    )).rejects.toMatchObject({
      code: "bootstrap_unavailable",
      context: { operationId: nonce, phase: "bootstrap" },
    });
    const trace = JSON.stringify(commands);
    expect(trace).not.toContain("config.rollback-");
    expect(trace).not.toContain("nohup");
    expect(trace).not.toContain("tailscale serve --bg");
  });

  test("partial Serve mutation is reversed and failed credentials are scrubbed", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-bootstrap-rollback-test-"));
    const commands: string[][] = [];
    let serveConfigured = false;
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      randomUUID: () => nonce,
      runCommand: async (argv: readonly string[]) => {
        commands.push([...argv]);
        const command = argv.at(-1) ?? "";
        if (argv[0] === "npm") {
          const destination = argv[argv.indexOf("--pack-destination") + 1]!;
          await writeFile(join(destination, "grokbox-0.0.1.tgz"), "package");
          return { code: 0, stdout: "grokbox-0.0.1.tgz\n", stderr: "" };
        }
        if (command.includes("require('node:os').homedir()")) {
          return { code: 0, stdout: "/home/box\n", stderr: "" };
        }
        if (command === "sudo -n tailscale serve status --json") {
          return {
            code: 0,
            stdout: serveConfigured
              ? JSON.stringify({
                  TCP: { "8443": { HTTPS: true } },
                  Web: {
                    "box.example.ts.net:8443": {
                      Handlers: { "/": { Proxy: "http://127.0.0.1:37134" } },
                    },
                  },
                })
              : "{}",
            stderr: "",
          };
        }
        if (command.includes("tailscale serve --bg")) {
          serveConfigured = true;
          return { code: 1, stdout: "", stderr: "applied but response failed" };
        }
        if (command.includes("tailscale serve --yes --https=8443 off")) {
          serveConfigured = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    expect(bootstrapPeerDaemon(
      deps,
      "remote",
      { name: "box", dnsName: "box.example.ts.net", ipv4: "192.0.2.20" },
      "box",
    )).rejects.toMatchObject({ code: "tailscale_not_ready" });
    expect(serveConfigured).toBe(false);
    expect(commands.some((argv) => argv.at(-1)?.includes("--https=8443 off"))).toBe(true);
    expect(commands.some((argv) => argv.at(-1)?.includes("config.rollback-"))).toBe(true);
    expect(JSON.stringify(commands)).not.toContain("serve reset");
    const secrets = await readdir(join(configDir, "secrets"));
    expect(secrets).toHaveLength(1);
    expect(await readFile(join(configDir, "secrets", secrets[0]!), "utf8")).toBe("revoked");
  });

  test("generated mapping ownership probe recognizes only the recorded exact handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokbox-owned-mapping-test-"));
    await writeDaemonConfig(join(home, ".grokbox"), {
      version: 1,
      network: {
        host: "127.0.0.1",
        port: 37134,
        tokenSha256: createHash("sha256").update("credential").digest("hex"),
      },
      serve: {
        httpsPort: 8443,
        dnsName: "box.example.ts.net",
        proxyUrl: "http://127.0.0.1:37134",
      },
    });
    const command = ownedMappingProbeCommand("box.example.ts.net");
    const accepted = Bun.spawn(["sh", "-c", command], { env: { ...process.env, HOME: home } });
    expect(await accepted.exited).toBe(0);
    const rejected = Bun.spawn(["sh", "-c", ownedMappingProbeCommand("other.example.ts.net")], {
      env: { ...process.env, HOME: home },
    });
    expect(await rejected.exited).toBe(1);
  });

  test("a concurrent daemon cancel prevents a pending open from publishing its descriptor", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-daemon-fs-cancel-"));
    const root = join(configDir, "root");
    const socket = join(configDir, "run", "daemon.sock");
    await mkdir(root);
    const file = join(root, "pending.bin");
    await writeFile(file, "");
    await truncate(file, 64 * 1024 * 1024);
    gateway = await startMockGateway();
    const discoveryPath = await writeDiscovery({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: gateway.token,
    });
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      discoveryPath,
      daemonSocket: socket,
      transport: "local" as const,
    };
    host = await startDaemonHost(deps, socket, undefined, [
      { name: "home", path: root, operations: ["download"] },
    ]);
    const client = new LocalDaemonClient(socket, 10_000);
    const transferId = "44444444-4444-4444-8444-444444444444";
    const opening = client.call("fsDownloadOpen", {
      path: "home:/pending.bin",
      transferId,
    }).catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await client.call("fsDownloadCancel", { transferId });
    expect(cancelled.result).toEqual({ transferId, cancelled: true });
    expect((await opening).code).toBe("fs_transfer_invalid");
    await expect(client.call("fsDownloadChunk", { transferId, index: 0 })).rejects.toMatchObject({
      code: "fs_transfer_invalid",
    });
  });

  test("handshake is versioned, redacted, and socket-gated", async () => {
    const { socket } = await fixture();
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const handshake = await new LocalDaemonClient(socket, 10_000).handshake();
    expect(handshake.protocolMajor).toBe(DAEMON_PROTOCOL_MAJOR);
    expect(handshake.daemonVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(handshake.daemonGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(handshake.capabilities).toContain("grok.transcript.write");
    expect(handshake.capabilities).toContain("grok.events.read");
    expect(handshake.filesystemRoots).toEqual([]);
    expect(handshake.gateway).toEqual({ pid: gateway!.pid, startedAt: gateway!.startedAt });
    const dumped = JSON.stringify(handshake);
    expect(dumped).not.toContain(gateway?.token ?? "never");
    expect(dumped).not.toContain("Authorization");
  });

  test("a competing daemon cannot unlink the live daemon socket", async () => {
    const { socket, deps } = await fixture();
    const first = host;
    await expect(startDaemonHost(deps, socket)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await new LocalDaemonClient(socket, 10_000).handshake()).daemonPid).toBe(process.pid);
    expect(host).toBe(first);
  });

  test("remote listener separates shared-credential auth from local socket access", async () => {
    const { configDir, socket, deps, run } = await fixture();
    await host?.close();
    host = undefined;
    const token = "remote-test-token-with-enough-entropy";
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    host = await startDaemonHost(deps, socket, {
      host: "127.0.0.1",
      port: 0,
      tokenSha256,
    });
    const port = host.network?.port;
    expect(port).toBeNumber();
    const serverUrl = `http://127.0.0.1:${port}`;

    const rejected = new RemoteDaemonClient(serverUrl, "wrong-token", 10_000, fetch);
    expect(rejected.handshake()).rejects.toMatchObject({ code: "daemon_unauthorized" });
    expect(gateway?.requests).toEqual([]);

    const remoteHandshake = await new RemoteDaemonClient(serverUrl, token, 10_000, fetch).handshake();
    expect(remoteHandshake.protocolMajor).toBe(DAEMON_PROTOCOL_MAJOR);
    expect((await new LocalDaemonClient(socket, 10_000).handshake()).protocolMajor).toBe(DAEMON_PROTOCOL_MAJOR);

    const secretPath = join(configDir, "secrets", "remote-daemon");
    await writeProtectedSecret(secretPath, token);
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: serverUrl,
      daemon_token_ref: `file:${secretPath}`,
    });

    const doctor = await run(["--profile", "remote", "doctor"]);
    expect(doctor.code).toBe(0);
    const remoteDoctor = parseJson(doctor.stdout) as {
      data: { discovery: { scheme: string }; checks: { tailnetIdentity: string } };
    };
    expect(remoteDoctor.data.discovery.scheme).toBe("http");
    expect(remoteDoctor.data.checks.tailnetIdentity).toBe("unverified");
    expect((await run(["--profile", "remote", "agents", "list"])).code).toBe(0);
    const remoteEvents = await run(["--profile", "remote", "events", "--once", "--sources", "daemon"]);
    expect(remoteEvents.code, remoteEvents.stderr).toBe(0);
    const remoteEvent = parseJson(remoteEvents.stdout) as { event: { source: string; kind: string }; cursor: string };
    expect(remoteEvent.event).toMatchObject({ source: "daemon", kind: "started" });
    expect(remoteEvent.cursor).toContain(remoteHandshake.daemonGeneration);
    expect((await run(["--profile", "remote", "history", "tail", "agent-alpha"])).code).toBe(0);
    expect((await run([
      "--profile",
      "remote",
      "send",
      "agent-alpha",
      "--text",
      "remote hello",
      "--nonce",
      nonce,
    ])).code).toBe(0);

    const missingCredentialProfile = "remote-missing-credential";
    await writeProfileFile(configDir, missingCredentialProfile, {
      version: 1,
      transport: "daemon",
      server_url: serverUrl,
    });
    const missingCredential = await run(["--profile", missingCredentialProfile, "agents", "list"]);
    expect(missingCredential.code).toBe(32);
    expect((parseJson(missingCredential.stderr) as { error: { code: string } }).error.code).toBe("daemon_credential_required");

    const wrongSecretPath = join(configDir, "secrets", "wrong-daemon");
    await writeProtectedSecret(wrongSecretPath, "incorrect");
    await writeProfileFile(configDir, "remote-wrong-credential", {
      version: 1,
      transport: "daemon",
      server_url: serverUrl,
      daemon_token_ref: `file:${wrongSecretPath}`,
    });
    const wrongCredential = await run(["--profile", "remote-wrong-credential", "agents", "list"]);
    expect(wrongCredential.code).toBe(34);
    expect((parseJson(wrongCredential.stderr) as { error: { code: string } }).error.code).toBe("daemon_unauthorized");

    const output = `${doctor.stdout}${doctor.stderr}${missingCredential.stderr}${wrongCredential.stderr}`;
    expect(output).not.toContain(token);
    expect(await readFile(join(configDir, "profiles", "remote", "config.json"), "utf8")).not.toContain(token);
    expect(await unauthorizedBeforeBody(port!)).toBe(401);
  });

  test("daemon network config is strict, protected, and stores only a credential hash", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-daemon-config-test-"));
    const tokenSha256 = createHash("sha256").update("credential").digest("hex");
    await writeDaemonConfig(configDir, {
      version: 1,
      network: { host: "127.0.0.1", port: 37134, tokenSha256 },
      serve: {
        httpsPort: 8443,
        dnsName: "box.example.ts.net",
        proxyUrl: "http://127.0.0.1:37134",
      },
    });
    const path = join(configDir, "daemon", "config.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readDaemonConfig(configDir)).toEqual({
      version: 1,
      network: { host: "127.0.0.1", port: 37134, tokenSha256 },
      serve: {
        httpsPort: 8443,
        dnsName: "box.example.ts.net",
        proxyUrl: "http://127.0.0.1:37134",
      },
    });
    expect(writeDaemonConfig(configDir, {
      version: 1,
      network: { host: "0.0.0.0", port: 37134, tokenSha256 } as never,
    })).rejects.toMatchObject({ code: "profile_invalid" });
  });

  test("remote client reports protocol mismatch, timeout, and reconnect stably", async () => {
    const incompatibleFetch = (async () => Response.json({
      ok: true,
      result: { protocolMajor: 99 },
    })) as unknown as typeof fetch;
    const incompatible = new RemoteDaemonClient("https://daemon.invalid", "token", 100, incompatibleFetch);
    expect(incompatible.handshake()).rejects.toMatchObject({ code: "daemon_protocol_mismatch" });

    let attempts = 0;
    const reconnectingFetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("timed out", "TimeoutError");
      return Response.json({
        ok: true,
        result: {
          protocolMajor: DAEMON_PROTOCOL_MAJOR,
          daemonVersion: "0.0.1",
          daemonPid: 1,
          startedAt: 2,
          daemonGeneration: "11111111-1111-4111-8111-111111111111",
          capabilities: [],
          filesystemRoots: [],
          gateway: { pid: 1234, startedAt: 1700000000000 },
        },
      });
    }) as unknown as typeof fetch;
    const reconnecting = new RemoteDaemonClient("https://daemon.invalid", "token", 10, reconnectingFetch);
    expect(reconnecting.handshake()).rejects.toMatchObject({ code: "daemon_unreachable", retryable: true });
    expect((await reconnecting.handshake()).protocolMajor).toBe(DAEMON_PROTOCOL_MAJOR);

    const unavailable = new RemoteDaemonClient("http://127.0.0.1:1", "token", 50, fetch);
    expect(unavailable.handshake()).rejects.toMatchObject({ code: "daemon_unreachable", retryable: true });

    for (const error of [
      { code: "ok", message: "invalid success code" },
      { code: "fs_conflict", message: 42 },
      { code: "fs_conflict", message: "missing retryable" },
      { code: "fs_conflict", message: "invalid retryable", retryable: "yes" },
      { code: "fs_conflict", message: "extra field", retryable: false, extra: true },
    ]) {
      const malformed = new RemoteDaemonClient(
        "https://daemon.invalid",
        "token",
        100,
        (async () => Response.json({ ok: false, error })) as unknown as typeof fetch,
      );
      await expect(malformed.handshake()).rejects.toMatchObject({ code: "daemon_unreachable" });
    }
    const topLevelExtra = new RemoteDaemonClient(
      "https://daemon.invalid",
      "token",
      100,
      (async () => Response.json({
        ok: false,
        error: { code: "fs_conflict", message: "valid shape", retryable: false },
        extra: true,
      })) as unknown as typeof fetch,
    );
    await expect(topLevelExtra.handshake()).rejects.toMatchObject({ code: "daemon_unreachable" });
    const successExtra = new RemoteDaemonClient(
      "https://daemon.invalid",
      "token",
      100,
      (async () => Response.json({ ok: true, result: {}, extra: true })) as unknown as typeof fetch,
    );
    await expect(successExtra.handshake()).rejects.toMatchObject({ code: "daemon_unreachable" });
  });

  test("doctor, roster, history, and send use daemon while preserving envelopes", async () => {
    const { run } = await fixture();
    const doctor = await run(["--profile", "daemon", "doctor"]);
    expect(doctor.code).toBe(0);
    const doctorBody = parseJson(doctor.stdout) as {
      data: { discovery: { scheme: string; tokenPresent: boolean }; health: { ok: boolean } };
    };
    expect(doctorBody.data.discovery.scheme).toBe("unix");
    expect(doctorBody.data.discovery.tokenPresent).toBe(false);
    expect(doctorBody.data.health.ok).toBe(true);

    const agents = await run(["--profile", "daemon", "agents", "list"]);
    expect(agents.code).toBe(0);
    expect((parseJson(agents.stdout) as { data: { count: number } }).data.count).toBe(1);

    const search = await run(["--profile", "daemon", "history", "search", "status"]);
    expect(search.code).toBe(0);

    const send = await run([
      "--profile",
      "daemon",
      "send",
      "agent-alpha",
      "--text",
      "hello",
      "--nonce",
      nonce,
    ]);
    expect(send.code).toBe(0);
    expect(rpcCalls(gateway?.requests ?? [], "sendPrompt")[0]?.body).toEqual({
      agentId: "agent-alpha",
      prompt: "hello",
      clientNonce: nonce,
    });
  });

  test("the built-in default profile selects an available daemon in auto mode", async () => {
    const { run } = await fixture();
    const result = await run(["doctor"]);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as { data: { discovery: { scheme: string } } };
    expect(body.data.discovery.scheme).toBe("unix");
  });

  test("an explicit local profile bypasses the daemon", async () => {
    const { configDir, discoveryPath, run } = await fixture();
    await writeProfileFile(configDir, "direct", {
      version: 1,
      transport: "local",
      gateway_discovery: discoveryPath,
    });
    await host?.close();
    host = undefined;

    const result = await run(["--profile", "direct", "doctor"]);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as { data: { discovery: { scheme: string } } };
    expect(body.data.discovery.scheme).toBe("http");
  });

  test("daemon serve reports readiness and removes its socket on graceful shutdown", async () => {
    const { configDir, discoveryPath, socket } = await fixture();
    await host?.close();
    host = undefined;
    await writeProfileFile(configDir, "serve", {
      version: 1,
      transport: "local",
      daemon_socket: socket,
      gateway_discovery: discoveryPath,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await captureCli(["--profile", "serve", "daemon", "serve"], {
      configDir,
      env: {},
      discoveryPath: "/must-not-be-used-directly.json",
      daemonSocket: socket,
      transport: "auto",
      skillsDir,
      signal: controller.signal,
    });
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as { data: { ready: boolean; protocolMajor: number } };
    expect(body.data.ready).toBe(true);
    expect(body.data.protocolMajor).toBe(DAEMON_PROTOCOL_MAJOR);
    expect(stat(socket)).rejects.toThrow();
  });

  test("daemon serve removes its socket when startup discovery fails", async () => {
    const { configDir, run, socket } = await fixture();
    await host?.close();
    host = undefined;
    await writeProfileFile(configDir, "broken", {
      version: 1,
      transport: "local",
      daemon_socket: socket,
      gateway_discovery: join(configDir, "missing-gateway.json"),
    });

    const result = await run(["--profile", "broken", "daemon", "serve"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("discovery_unavailable");
    expect(stat(socket)).rejects.toThrow();
  });

  test("daemon status is the only daemon diagnostic route", async () => {
    const { run } = await fixture();
    const status = await run(["--profile", "daemon", "daemon", "status"]);
    expect(status.code).toBe(0);
    const body = parseJson(status.stdout) as { data: { protocolMajor: number; socket: string } };
    expect(body.data.protocolMajor).toBe(1);
    expect(body.data.socket).toContain("daemon.sock");

    const ensure = await run(["--profile", "daemon", "daemon", "ensure"]);
    expect(ensure.code).toBe(0);
    expect((parseJson(ensure.stdout) as { data: { ensured: boolean; changed: boolean } }).data).toMatchObject({
      ensured: true,
      changed: false,
    });

    const removed = await run(["--profile", "daemon", "daemon", "doctor"]);
    expect(removed.code).toBe(2);
    expect(gateway?.requests.filter((entry) => entry.pathname === "/health")).toHaveLength(0);
  });

  test("explicit daemon provides unified events and refuses unreachable sockets", async () => {
    const { configDir, run } = await fixture();
    const events = await run(["--profile", "daemon", "events", "--once"]);
    expect(events.code, events.stderr).toBe(0);
    const projected = parseJson(events.stdout) as { event: { source: string; kind: string }; cursor: string };
    expect(projected.event).toMatchObject({ source: "daemon", kind: "started" });
    expect(projected.cursor).toContain(":");

    await writeProfileFile(configDir, "missing", {
      version: 1,
      transport: "daemon",
      daemon_socket: join(configDir, "missing.sock"),
    });
    const unavailable = await run(["--profile", "missing", "agents", "list"]);
    expect(unavailable.code).toBe(26);
    expect((parseJson(unavailable.stderr) as { error: { code: string } }).error.code).toBe("daemon_unreachable");
  });

  test("protocol major mismatch fails before dispatch", async () => {
    const { socket } = await fixture();
    const response = await rawRpc(socket, {
      protocolMajor: 99,
      method: "listAgents",
      params: {},
    });
    expect(response.status).toBe(409);
    const body = response.body as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("daemon_protocol_mismatch");
    expect(gateway?.requests).toEqual([]);
  });
});
