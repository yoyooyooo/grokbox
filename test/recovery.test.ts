import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile, writeProtectedSecret } from "../src/config/profile.ts";
import { createProductionDeps } from "../src/deps.ts";
import { captureCli, parseJson } from "./helpers.ts";

const profileName = "remote";
const endpoint = "https://box.example.ts.net:8443";
const hostname = "box.example.ts.net";
const token = "daemon-test-token";
const sandboxToken = "cursor-account-test-token";
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const skillsDir = join(import.meta.dir, "..", "skills");

function daemonHandshake() {
  return {
    protocolMajor: 1,
    daemonVersion: "0.0.1",
    daemonPid: 123,
    startedAt: 1_700_000_000_000,
    daemonGeneration: "11111111-1111-4111-8111-111111111111",
    capabilities: ["grok.health.read"],
    filesystemRoots: [],
    gateway: { pid: 4242, startedAt: 1_700_000_000_100 },
  };
}

function serveStatus(exact: boolean): string {
  if (!exact) return "{}";
  return JSON.stringify({
    TCP: { "8443": { HTTPS: true } },
    Web: {
      [`${hostname}:8443`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:37134" } },
      },
    },
  });
}

function connectFrame(flags: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(5 + payload.byteLength);
  frame[0] = flags;
  frame.writeUInt32BE(payload.byteLength, 1);
  payload.copy(frame, 5);
  return frame;
}

function execSuccess(): Buffer {
  return Buffer.concat([
    connectFrame(0, { execClientMessage: { shellResult: { success: {} } } }),
    connectFrame(2, {}),
  ]);
}

async function remoteFixture(options: {
  sandbox?: boolean;
  missingDaemonCredential?: boolean;
  fetch: typeof fetch;
  runCommand: ReturnType<typeof commandAdapter>;
}) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-recovery-test-"));
  const daemonSecret = join(configDir, "secrets", "daemon");
  const sandboxSecret = join(configDir, "secrets", "sandbox");
  if (!options.missingDaemonCredential) await writeProtectedSecret(daemonSecret, token);
  if (options.sandbox) await writeProtectedSecret(sandboxSecret, sandboxToken);
  await writeProfileFile(configDir, profileName, {
    version: 1,
    transport: "daemon",
    server_url: endpoint,
    daemon_token_ref: options.missingDaemonCredential ? "env:MISSING_DAEMON_TOKEN" : `file:${daemonSecret}`,
    ssh_host: hostname,
    ...(options.sandbox ? { sandbox: { access_token_ref: `file:${sandboxSecret}` } } : {}),
  });
  return async (argv: string[]) => await captureCli(["--profile", profileName, ...argv], {
    configDir,
    env: {},
    fetch: options.fetch,
    runCommand: options.runCommand,
    skillsDir,
    stdinIsTTY: true,
    readStdin: async () => "",
    randomUUID: () => nonce,
    now: () => 1_700_000_001_000,
    wait: async () => true,
  });
}

function commandAdapter(handler?: (argv: readonly string[], command: string) => { code: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const adapter = async (argv: readonly string[]) => {
    calls.push([...argv]);
    const command = argv.at(-1) ?? "";
    return handler?.(argv, command) ?? { code: 127, stdout: "", stderr: "unexpected command" };
  };
  adapter.calls = calls;
  return adapter;
}

function healthyDaemonFetch(events: string[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      events.push("daemon-http");
      return new Response("", { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    events.push(`daemon-${body.method}`);
    if (body.method === "handshake") return Response.json({ ok: true, result: daemonHandshake() });
    if (body.method === "health") {
      return Response.json({
        ok: true,
        result: {
          ok: true,
          pid: 4242,
          isBusy: false,
          activeAgentId: null,
          startedAt: 1_700_000_000_100,
          lastBusyAtMs: 1_700_000_000_100,
        },
        gateway: { pid: 4242, startedAt: 1_700_000_000_100 },
      });
    }
    return Response.json({ ok: false, error: { code: "gateway_not_found", message: "not found", retryable: false } });
  }) as typeof fetch;
}

describe("layered doctor and explicit recovery", () => {
  test("production command adapter enforces child-process deadlines", async () => {
    const result = await createProductionDeps().runCommand(
      [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 25 },
    );
    expect(result.code).toBe(124);
    expect(result.stderr).toBe("Command timed out.");
  });

  test("doctor proves each reachable boundary without wake, Serve mutation, or daemon start", async () => {
    const events: string[] = [];
    const commands = commandAdapter((argv, command) => {
      events.push(`command:${argv[0]}:${command}`);
      if (argv[0] === "tailscale" && argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            Peer: {
              peer: { DNSName: `${hostname}.`, HostName: "box", Online: true, TailscaleIPs: ["192.0.2.20"] },
            },
          }),
          stderr: "",
        };
      }
      if (argv[0] === "tailscale" && argv[1] === "ping") return { code: 0, stdout: "pong via DERP(region)", stderr: "" };
      if (command === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "sudo -n tailscale serve status --json") return { code: 0, stdout: serveStatus(true), stderr: "" };
      if (command.includes(".serve?.httpsPort")) return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const run = await remoteFixture({ fetch: healthyDaemonFetch(events), runCommand: commands });
    const result = await run(["doctor"]);
    expect(result.code, result.stderr).toBe(0);
    const report = (parseJson(result.stdout) as { data: Record<string, any> }).data;
    expect(report.ok).toBe(true);
    expect(report.checks).toMatchObject({
      profile: { status: "pass", code: "profile_valid" },
      secretSession: { status: "pass", code: "daemon_credential_resolved", source: "file" },
      sandbox: { status: "skipped" },
      tailnet: { status: "pass", code: "tailnet_peer_reachable", path: "relay" },
      serve: { status: "pass", code: "serve_mapping_exact" },
      daemonHttp: { status: "pass", code: "daemon_http_auth_gate_reached" },
      daemonAuth: { status: "pass", code: "daemon_credential_accepted" },
      capabilities: { status: "pass", code: "grok_health_capability_authorized" },
      gateway: { status: "pass", code: "gateway_healthy" },
    });
    const trace = JSON.stringify({ events, commands: commands.calls });
    expect(trace).not.toContain("EnsureSandBox");
    expect(trace).not.toContain("tailscale serve --bg");
    expect(trace).not.toContain("daemon serve");
    expect(trace).not.toContain("sendPrompt");
  });

  test("authenticated daemon HTTPS reconciles a false-negative Tailscale ping", async () => {
    const commands = commandAdapter((argv, command) => {
      if (argv[0] === "tailscale" && argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            Peer: {
              peer: { DNSName: `${hostname}.`, HostName: "box", Online: true, TailscaleIPs: ["192.0.2.20"] },
            },
          }),
          stderr: "",
        };
      }
      if (argv[0] === "tailscale" && argv[1] === "ping") return { code: 1, stdout: "", stderr: "timed out" };
      if (command === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "sudo -n tailscale serve status --json") return { code: 0, stdout: serveStatus(true), stderr: "" };
      if (command.includes(".serve?.httpsPort")) return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const run = await remoteFixture({ fetch: healthyDaemonFetch([]), runCommand: commands });
    const result = await run(["doctor"]);
    expect(result.code, result.stderr).toBe(0);
    const report = (parseJson(result.stdout) as { data: Record<string, any> }).data;
    expect(report.ok).toBe(true);
    expect(report.checks.tailnet).toEqual({
      status: "pass",
      code: "tailnet_peer_reachable_via_daemon_https",
      action: "none",
      path: "reachable",
    });
    expect(report.checks.tailnetIdentity).toBe("verified");
  });

  test("recover orders Sandbox wake, tailnet IPv4, exact Serve restore, installed daemon ensure, and final doctor", async () => {
    const events: string[] = [];
    let woken = false;
    let mappingExact = false;
    let daemonRunning = false;
    const commands = commandAdapter((argv, command) => {
      if (argv[0] === "tailscale" && argv[1] === "status") {
        events.push(`tailnet-status:${woken}`);
        return {
          code: 0,
          stdout: JSON.stringify({
            Peer: {
              peer: {
                DNSName: `${hostname}.`,
                HostName: "box",
                Online: woken,
                TailscaleIPs: woken ? ["192.0.2.20"] : [],
              },
            },
          }),
          stderr: "",
        };
      }
      if (argv[0] === "tailscale" && argv[1] === "ping") {
        events.push("tailnet-ping");
        return { code: woken ? 0 : 1, stdout: woken ? "pong via 192.0.2.20" : "", stderr: "" };
      }
      if (command === "true") {
        events.push(`ssh-preflight:${woken}`);
        return { code: woken ? 0 : 255, stdout: "", stderr: "" };
      }
      if (command === "sudo -n tailscale serve status --json") {
        events.push(`serve-status:${mappingExact}`);
        return { code: 0, stdout: serveStatus(mappingExact), stderr: "" };
      }
      if (command.includes(".serve?.httpsPort")) {
        events.push("serve-ownership");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("tailscale serve --bg")) {
        events.push("serve-restore");
        mappingExact = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("nohup \"$binary\" daemon serve")) {
        events.push("daemon-ensure");
        daemonRunning = true;
        return { code: 0, stdout: "changed\n", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("GetSandBoxRunState")) {
        events.push("sandbox-status");
        return Response.json({ state: "HIBERNATED", imageUpdateAvailable: false });
      }
      if (url.includes("EnsureSandBox")) {
        events.push("sandbox-wake");
        woken = true;
        return Response.json({
          execDaemonUrl: "https://exec.example.invalid",
          execDaemonAuthToken: "exec-auth",
          networkToken: "network-auth",
          podId: "pod-1",
        });
      }
      if (url.includes("agent.v1.ExecService/Exec")) {
        events.push("sandbox-noop");
        return new Response(execSuccess(), { status: 200, headers: { "content-type": "application/connect+json" } });
      }
      if (!daemonRunning) {
        events.push("daemon-unreachable");
        throw new Error("unreachable");
      }
      return await healthyDaemonFetch(events)(input, init);
    }) as typeof fetch;
    const run = await remoteFixture({ sandbox: true, fetch: fetchFn, runCommand: commands });
    const result = await run(["recover", "--timeout-ms", "10000"]);
    expect(result.code, result.stderr).toBe(0);
    const body = (parseJson(result.stdout) as { data: Record<string, any> }).data;
    expect(body).toMatchObject({
      recovered: true,
      changed: true,
      operationId: nonce,
      actions: [
        { action: "sandbox-wake", changed: true },
        { action: "tailnet-wait", outcome: "peer-and-ipv4-reachable" },
        { action: "serve-restore", changed: true, outcome: "exact" },
        { action: "daemon-ensure", changed: true, outcome: "started" },
      ],
      doctor: { ok: true },
    });
    expect(events.indexOf("sandbox-wake")).toBeLessThan(events.indexOf("tailnet-ping"));
    expect(events.indexOf("tailnet-ping")).toBeLessThan(events.indexOf("serve-restore"));
    expect(events.indexOf("serve-restore")).toBeLessThan(events.indexOf("daemon-ensure"));
    expect(events.indexOf("daemon-ensure")).toBeLessThan(events.lastIndexOf("daemon-health"));
    expect(JSON.stringify(events)).not.toContain("sendPrompt");
    expect(JSON.stringify(commands.calls)).not.toContain("tailscale serve reset");
  });

  test("recover stops before mutation when the required daemon credential is unavailable", async () => {
    const events: string[] = [];
    const commands = commandAdapter((argv, command) => {
      if (argv[0] === "tailscale" && argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({ Peer: { peer: { DNSName: `${hostname}.`, HostName: "box", Online: true, TailscaleIPs: ["192.0.2.20"] } } }),
          stderr: "",
        };
      }
      if (argv[0] === "tailscale" && argv[1] === "ping") return { code: 0, stdout: "pong", stderr: "" };
      if (command === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "sudo -n tailscale serve status --json") return { code: 0, stdout: serveStatus(true), stderr: "" };
      if (command.includes(".serve?.httpsPort")) return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const run = await remoteFixture({
      missingDaemonCredential: true,
      fetch: healthyDaemonFetch(events),
      runCommand: commands,
    });
    const result = await run(["recover"]);
    expect(result.code).toBe(57);
    const error = (parseJson(result.stderr) as { error: { code: string; failureCode: string } }).error;
    expect(error).toMatchObject({ code: "recover_unavailable", failureCode: "daemon_credential_failed" });
    const trace = JSON.stringify(commands.calls);
    expect(trace).not.toContain("tailscale serve --bg");
    expect(trace).not.toContain("daemon serve");
    expect(JSON.stringify(events)).not.toContain("EnsureSandBox");
  });

  test("recover refuses Serve drift without overwriting the occupied handler or starting the daemon", async () => {
    const commands = commandAdapter((argv, command) => {
      if (argv[0] === "tailscale" && argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({ Peer: { peer: { DNSName: `${hostname}.`, HostName: "box", Online: true, TailscaleIPs: ["192.0.2.20"] } } }),
          stderr: "",
        };
      }
      if (argv[0] === "tailscale" && argv[1] === "ping") return { code: 0, stdout: "pong", stderr: "" };
      if (command === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "sudo -n tailscale serve status --json") {
        return {
          code: 0,
          stdout: JSON.stringify({
            TCP: { "8443": { HTTPS: true } },
            Web: { [`${hostname}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
          }),
          stderr: "",
        };
      }
      if (command.includes(".serve?.httpsPort")) return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const run = await remoteFixture({
      fetch: (async () => { throw new Error("unreachable"); }) as unknown as typeof fetch,
      runCommand: commands,
    });
    const result = await run(["recover"]);
    expect(result.code).toBe(58);
    const error = (parseJson(result.stderr) as {
      error: { failureCode: string; retryable: boolean; context: { operationId: string; phase: string } };
    }).error;
    expect(error).toMatchObject({
      failureCode: "serve_mapping_drifted",
      retryable: false,
      context: { operationId: nonce, phase: "serve-restore" },
    });
    const trace = JSON.stringify(commands.calls);
    expect(trace).not.toContain("tailscale serve --bg");
    expect(trace).not.toContain("nohup");
    expect(trace).not.toContain("tailscale serve reset");
  });

  test("daemon ensure starts only an installed daemon and does not bootstrap or alter Serve", async () => {
    const events: string[] = [];
    let daemonRunning = false;
    const commands = commandAdapter((_argv, command) => {
      if (command.includes("nohup \"$binary\" daemon serve")) {
        events.push("daemon-ensure");
        daemonRunning = true;
        return { code: 0, stdout: "changed\n", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!daemonRunning) throw new Error("unreachable");
      return await healthyDaemonFetch(events)(input, init);
    }) as typeof fetch;
    const run = await remoteFixture({ fetch: fetchFn, runCommand: commands });
    const result = await run(["daemon", "ensure"]);
    expect(result.code, result.stderr).toBe(0);
    const body = (parseJson(result.stdout) as { data: Record<string, any> }).data;
    expect(body).toMatchObject({
      ensured: true,
      changed: true,
      operationId: nonce,
      audit: { action: "daemon-ensure-installed", outcome: "started", credential: "not-recorded" },
    });
    const trace = JSON.stringify(commands.calls);
    expect(trace).not.toContain("tailscale serve");
    expect(trace).not.toContain("npm");
    expect(trace).not.toContain("scp");
  });
});
