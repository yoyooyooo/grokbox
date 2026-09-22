import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile, writeProtectedSecret } from "../packages/cli/src/config/profile.ts";
import { remoteEnsureInstalledDaemonCommand } from "../packages/cli/src/daemon/ssh-recovery.ts";
import { readDaemonConfig, writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { LocalDaemonClient, RemoteDaemonClient } from "../packages/cli/src/daemon/client.ts";
import { startDaemonHost, type DaemonHost } from "../packages/cli/src/daemon/host.ts";
import { DAEMON_PROTOCOL_MAJOR } from "../packages/cli/src/daemon/protocol.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
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
  test("the finite installed-service recovery script is POSIX and has no install or network authority", async () => {
    const script = remoteEnsureInstalledDaemonCommand();
    const proc = Bun.spawn(["sh", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(script); proc.stdin.end();
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await proc.exited).toBe(0);
    expect(script).toContain("daemon status >/dev/null");
    for (const forbidden of ["&;", "tailscale", "sudo", "npm", "scp", "bootstrap", "--confirm"]) expect(script).not.toContain(forbidden);
  });

  test("local installation preserves admitted roots through the canonical configuration owner", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-bootstrap-policy-"));
    const workspace = { name: "workspace", path: "/workspace/project", operations: ["stat", "read", "write", "upload"] as const };
    await writeDaemonConfig(configDir, { version: 1, filesystem: { roots: [{ ...workspace, operations: [...workspace.operations] }] } });
    await writeDaemonConfig(configDir, { version: 1, filesystem: { roots: [{ name: "home", path: "/home/box/project", operations: ["stat", "write", "upload"] }] } });
    await writeDaemonConfig(configDir, { version: 1, filesystem: { roots: [{ name: "home", path: "/home/box", operations: ["stat", "list", "read", "download"] }] } });
    expect((await readDaemonConfig(configDir)).filesystem?.roots).toEqual([
      { ...workspace, operations: [...workspace.operations] },
      { name: "home", path: "/home/box", operations: ["stat", "write", "upload", "list", "read", "download"] },
    ]);
    const before = await readFile(join(configDir, "config.json"), "utf8");
    await writeDaemonConfig(configDir, { version: 1 });
    expect(await readFile(join(configDir, "config.json"), "utf8")).toBe(before);
    expect(await stat(join(configDir, "daemon", "config.json")).catch(() => null)).toBeNull();
  });

  test("the remaining daemon cannot open, mutate or recover files through retired RPC names", async () => {
    const { socket } = await fixture(), client = new LocalDaemonClient(socket, 10_000);
    const handshake = await client.handshake();
    expect(handshake.capabilities.some(c => c.startsWith("host.fs"))).toBe(false);
    for (const method of ["fsDownloadOpen", "fsDownloadChunk", "fsDownloadCancel", "fsWrite", "fsMutationStatus"]) {
      await expect(client.call(method as never, { path: "home:/must-not-open" })).rejects.toMatchObject({ code: "gateway_not_found" });
    }
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
    expect(Object.hasOwn(handshake, "filesystemRoots")).toBe(false);
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
      data: { discovery: { scheme: string }; checks: Record<string, unknown> };
    };
    expect(remoteDoctor.data.discovery.scheme).toBe("http");
    expect(remoteDoctor.data.checks).not.toHaveProperty("tailnetIdentity");
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
    expect(await readFile(join(configDir, "config.json"), "utf8")).not.toContain(token);
    expect(await unauthorizedBeforeBody(port!)).toBe(401);
  });

  test("daemon network config is strict, protected, and stores only a credential hash", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-daemon-config-test-"));
    const tokenSha256 = createHash("sha256").update("credential").digest("hex");
    await writeDaemonConfig(configDir, { version: 1, network: { host: "127.0.0.1", port: 37134, tokenSha256 } });
    const path = join(configDir, "config.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain(tokenSha256);
    expect((await stat(join(configDir, "state", "installation.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(configDir, "state", "installation.json"), "utf8")).toContain(tokenSha256);
    expect(await readDaemonConfig(configDir)).toEqual({ version: 1, network: { host: "127.0.0.1", port: 37134, tokenSha256 } });
    const before = await readFile(path, "utf8");
    await expect(writeDaemonConfig(configDir, { version: 1, serve: { httpsPort: 8443, dnsName: "retired.invalid", proxyUrl: "http://127.0.0.1:37134" } } as never)).rejects.toMatchObject({ code: "profile_invalid" });
    expect(await readFile(path, "utf8")).toBe(before);
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
