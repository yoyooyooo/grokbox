import { checkBatchModeSsh, inspectRecordedServeMapping } from "./bootstrap.ts";
import { resolveDaemonCredential, resolveSecretRef } from "./config/secret.ts";
import type { CliDeps } from "./deps.ts";
import { LocalDaemonClient, RemoteDaemonClient, type DaemonClient } from "./daemon/client.ts";
import type { DaemonHandshake } from "./daemon/protocol.ts";
import { CliError } from "./errors.ts";
import { GatewayClient, type Discovery } from "./gateway.ts";
import { CursorSandboxClient, CursorSandboxError } from "./sandbox/cursor.ts";
import { asBoolean, asNumber, isRecord } from "./util.ts";

export type DiagnosticStatus = "pass" | "fail" | "skipped" | "unverified";

export type DiagnosticCheck = {
  status: DiagnosticStatus;
  code: string;
  action: string;
  source?: string;
  path?: "direct" | "relay" | "reachable" | "unknown";
  state?: string;
};

export type DoctorReport = {
  ok: boolean;
  profile: { name: string; transport: string };
  discovery?: Omit<Discovery, "token" | "baseUrl">;
  health?: Record<string, unknown>;
  daemon?: {
    protocolMajor: number;
    version: string;
    generation: string;
    capabilityCount: number;
  };
  checks: {
    profile: DiagnosticCheck;
    secretSession: DiagnosticCheck;
    sandbox: DiagnosticCheck;
    tailnet: DiagnosticCheck;
    serve: DiagnosticCheck;
    daemonHttp: DiagnosticCheck;
    daemonAuth: DiagnosticCheck;
    capabilities: DiagnosticCheck;
    gateway: DiagnosticCheck;
    networkReachable: boolean;
    tailnetIdentity: string;
    sharedCredentialAccepted: boolean | string;
    capabilityAuthorized: boolean;
    loopbackTarget: boolean;
    generationMatches: boolean;
    authenticatedCommand: string;
  };
};

type TailnetPeerProbe = {
  status: DiagnosticCheck;
  hostname: string;
  ipv4Present: boolean;
};

const skipped = (code: string, action = "none"): DiagnosticCheck => ({ status: "skipped", code, action });
const failed = (code: string, action: string): DiagnosticCheck => ({ status: "fail", code, action });
const passed = (code: string, action = "none"): DiagnosticCheck => ({ status: "pass", code, action });

function refSource(ref: string | undefined): string {
  if (!ref) return "none";
  return ref.slice(0, ref.indexOf(":"));
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function publicFailure(error: unknown, fallback: string): string {
  if (error instanceof CliError) return error.code;
  if (error instanceof CursorSandboxError) return `sandbox_${error.kind}`;
  return fallback;
}

function healthProjection(health: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ok: asBoolean(health.ok),
    pid: health.pid ?? null,
    isBusy: asBoolean(health.isBusy),
    activeAgentId: health.activeAgentId ?? null,
    startedAt: health.startedAt ?? null,
    lastBusyAtMs: health.lastBusyAtMs ?? null,
  };
  if ("busyOnlyAwaitingApproval" in health) result.busyOnlyAwaitingApproval = health.busyOnlyAwaitingApproval;
  return result;
}

function discoveryProjection(discovery: Discovery): Omit<Discovery, "token" | "baseUrl"> {
  return {
    scheme: discovery.scheme,
    bindHost: discovery.bindHost,
    dialHost: discovery.dialHost,
    port: discovery.port,
    pid: discovery.pid,
    startedAt: discovery.startedAt,
    tokenPresent: discovery.tokenPresent,
  };
}

function peerRows(parsed: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(parsed.Peer)) return [];
  return Object.values(parsed.Peer).filter(isRecord);
}

function peerMatches(peer: Record<string, unknown>, hostname: string, sshHost?: string): boolean {
  const wanted = new Set(
    [hostname, sshHost, sshHost?.includes("@") ? sshHost.slice(sshHost.lastIndexOf("@") + 1) : undefined]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase().replace(/\.$/, "")),
  );
  const names = [peer.DNSName, peer.HostName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase().replace(/\.$/, ""));
  return names.some((name) => wanted.has(name));
}

export async function inspectTailnetPeer(
  deps: CliDeps,
  hostname: string,
  timeoutMs: number,
): Promise<TailnetPeerProbe> {
  const statusResult = await deps.runCommand(
    ["tailscale", "status", "--json"],
    { timeoutMs, signal: deps.signal },
  );
  if (statusResult.code !== 0) {
    return {
      status: failed("tailnet_status_unavailable", "Initialize Tailscale on the external runner and retry doctor."),
      hostname,
      ipv4Present: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusResult.stdout);
  } catch {
    return {
      status: failed("tailnet_status_invalid", "Upgrade or repair the external runner Tailscale client."),
      hostname,
      ipv4Present: false,
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: failed("tailnet_status_invalid", "Upgrade or repair the external runner Tailscale client."),
      hostname,
      ipv4Present: false,
    };
  }
  const peer = peerRows(parsed).find((entry) => peerMatches(entry, hostname, deps.sshHost));
  if (!peer) {
    return {
      status: failed("tailnet_peer_not_found", "Verify the Profile endpoint and tailnet membership."),
      hostname,
      ipv4Present: false,
    };
  }
  const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : [];
  const ipv4Present = ips.some((value) => typeof value === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (peer.Online === false) {
    return {
      status: failed("tailnet_peer_unreachable", "Use recover when Sandbox wake authority is configured."),
      hostname,
      ipv4Present,
    };
  }
  const seconds = Math.max(1, Math.min(300, Math.ceil(timeoutMs / 1000)));
  const ping = await deps.runCommand(
    ["tailscale", "ping", "--c", "1", `--timeout=${seconds}s`, hostname],
    { timeoutMs, signal: deps.signal },
  );
  if (ping.code !== 0) {
    return {
      status: failed("tailnet_peer_unreachable", "Use recover when Sandbox wake authority is configured."),
      hostname,
      ipv4Present,
    };
  }
  const path = /via derp\b/i.test(ping.stdout) ? "relay" : /via\s+\d/i.test(ping.stdout) ? "direct" : "reachable";
  return {
    status: { ...passed("tailnet_peer_reachable"), path },
    hostname,
    ipv4Present,
  };
}

async function probeRemoteDaemonHttp(
  deps: CliDeps,
  serverUrl: string,
  timeoutMs: number,
): Promise<DiagnosticCheck> {
  let response: Response;
  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = deps.signal ? AbortSignal.any([deadline, deps.signal]) : deadline;
    response = await deps.fetch(`${serverUrl.replace(/\/$/, "")}/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    });
  } catch {
    return failed("serve_https_unreachable", "Check tailnet reachability and the recorded private Serve mapping.");
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    return passed("daemon_http_auth_gate_reached");
  }
  return failed("daemon_listener_mismatch", "Verify that the private Serve handler targets the grokbox loopback listener.");
}

async function inspectServeOwnership(
  deps: CliDeps,
  hostname: string,
  timeoutMs: number,
): Promise<DiagnosticCheck> {
  if (!deps.sshHost || !(await checkBatchModeSsh(deps, deps.sshHost, timeoutMs))) {
    return {
      status: "unverified",
      code: "serve_state_unverified",
      action: "Configure the declared BatchMode SSH recovery adapter to verify mapping ownership.",
    };
  }
  try {
    const state = await inspectRecordedServeMapping(deps, deps.sshHost, hostname, timeoutMs);
    if (state === "exact") return passed("serve_mapping_exact");
    if (state === "absent") {
      return failed("serve_not_configured", "Run explicit recover to restore the recorded private mapping.");
    }
    if (state === "drifted") {
      return failed("serve_mapping_drifted", "Resolve the conflicting or changed Serve handler before recovery.");
    }
    return failed("serve_mapping_unrecorded", "Use confirmed daemon ensure --bootstrap for first-time mapping creation.");
  } catch {
    return {
      status: "unverified",
      code: "serve_state_unverified",
      action: "Verify passwordless SSH and Tailscale Serve read authority, then retry doctor.",
    };
  }
}

function daemonProjection(handshake: DaemonHandshake): DoctorReport["daemon"] {
  return {
    protocolMajor: handshake.protocolMajor,
    version: handshake.daemonVersion,
    generation: handshake.daemonGeneration,
    capabilityCount: handshake.capabilities.length,
  };
}

export async function diagnose(deps: CliDeps, timeoutMs: number): Promise<DoctorReport> {
  const remoteDaemon = Boolean(deps.daemonServerUrl) && deps.transport !== "local" && deps.transport !== "gateway";
  const explicitLocalDaemon = deps.transport === "daemon" && !deps.daemonServerUrl;
  let localAutoHandshake: DaemonHandshake | undefined;
  if (deps.transport === "auto" && !deps.daemonServerUrl) {
    localAutoHandshake = await new LocalDaemonClient(deps.daemonSocket, timeoutMs, deps.signal)
      .handshake()
      .catch(() => undefined);
  }

  const checks: DoctorReport["checks"] = {
    profile: passed("profile_valid"),
    secretSession: skipped("secret_not_required"),
    sandbox: skipped(deps.sandboxAccessTokenRef ? "sandbox_not_needed" : "sandbox_not_configured"),
    tailnet: skipped("tailnet_not_applicable"),
    serve: skipped("serve_not_applicable"),
    daemonHttp: skipped("daemon_http_not_applicable"),
    daemonAuth: skipped("daemon_auth_not_applicable"),
    capabilities: skipped("daemon_capabilities_not_applicable"),
    gateway: skipped("gateway_not_probed"),
    networkReachable: false,
    tailnetIdentity: "not-applicable",
    sharedCredentialAccepted: "not-applicable",
    capabilityAuthorized: false,
    loopbackTarget: false,
    generationMatches: false,
    authenticatedCommand: "not-probed",
  };

  let daemonToken: string | undefined;
  if (remoteDaemon) {
    try {
      daemonToken = deps.daemonToken ?? await resolveDaemonCredential(deps, deps.daemonTokenRef);
      checks.secretSession = { ...passed("daemon_credential_resolved"), source: refSource(deps.daemonTokenRef) };
    } catch (error) {
      checks.secretSession = failed(publicFailure(error, "daemon_credential_failed"), "Repair the selected daemon_token_ref.");
    }
  } else if (deps.gatewayTokenRef || deps.gatewayHeadersRef) {
    try {
      if (deps.gatewayTokenRef) await resolveSecretRef(deps, deps.gatewayTokenRef);
      if (deps.gatewayHeadersRef) await resolveSecretRef(deps, deps.gatewayHeadersRef);
      checks.secretSession = passed("gateway_session_resolved");
      checks.secretSession.source = deps.gatewayTokenRef ? refSource(deps.gatewayTokenRef) : refSource(deps.gatewayHeadersRef);
    } catch (error) {
      checks.secretSession = failed(publicFailure(error, "credential_unavailable"), "Repair the selected Gateway secret reference.");
    }
  } else {
    checks.secretSession = { ...passed("local_discovery_session"), source: "discovery-file" };
  }

  let hostname = "";
  if (remoteDaemon && deps.daemonServerUrl) {
    hostname = new URL(deps.daemonServerUrl).hostname;
    if (isLoopbackHost(hostname)) {
      checks.tailnet = skipped("tailnet_not_applicable_loopback");
      checks.tailnetIdentity = "unverified";
    } else {
      const tailnet = await inspectTailnetPeer(deps, hostname, timeoutMs);
      checks.tailnet = tailnet.status;
      checks.tailnetIdentity = tailnet.status.status === "pass" ? "verified" : "unverified";
      if (!tailnet.ipv4Present && tailnet.status.status === "pass") {
        checks.tailnet = failed("tailnet_ipv4_unavailable", "Wait for the box Tailscale IPv4 assignment before recovery.");
      }
      if (checks.tailnet.status !== "pass" && deps.sandboxAccessTokenRef) {
        try {
          const accessToken = await resolveSecretRef(deps, deps.sandboxAccessTokenRef);
          const status = await new CursorSandboxClient({
            accessToken,
            fetch: deps.fetch,
            timeoutMs,
            ...(deps.signal ? { signal: deps.signal } : {}),
            randomUUID: deps.randomUUID,
            now: deps.now,
          }).status();
          checks.sandbox = {
            ...passed("sandbox_status_read"),
            source: refSource(deps.sandboxAccessTokenRef),
            state: status.state,
          };
        } catch (error) {
          checks.sandbox = failed(publicFailure(error, "sandbox_unavailable"), "Repair Sandbox account access or retry later.");
        }
      }
    }

    checks.daemonHttp = await probeRemoteDaemonHttp(deps, deps.daemonServerUrl, timeoutMs);
    const ownership = isLoopbackHost(hostname)
      ? skipped("serve_not_applicable_loopback")
      : await inspectServeOwnership(deps, hostname, timeoutMs);
    checks.serve = ownership;
    checks.networkReachable = checks.daemonHttp.status === "pass";
  }

  let handshake: DaemonHandshake | undefined = localAutoHandshake;
  let daemonClient: DaemonClient | undefined;
  if (remoteDaemon && deps.daemonServerUrl && daemonToken && checks.daemonHttp.status === "pass") {
    daemonClient = new RemoteDaemonClient(deps.daemonServerUrl, daemonToken, timeoutMs, deps.fetch, deps.signal);
  } else if (explicitLocalDaemon || localAutoHandshake) {
    daemonClient = new LocalDaemonClient(deps.daemonSocket, timeoutMs, deps.signal);
    checks.daemonHttp = passed("daemon_unix_socket_reached");
    checks.networkReachable = true;
    checks.sharedCredentialAccepted = "not-required-local-socket";
  }

  if (daemonClient) {
    try {
      handshake ??= await daemonClient.handshake();
      checks.daemonAuth = passed(remoteDaemon ? "daemon_credential_accepted" : "daemon_local_socket_accepted");
      checks.sharedCredentialAccepted = remoteDaemon ? true : "not-required-local-socket";
      if (handshake.capabilities.includes("grok.health.read")) {
        checks.capabilities = passed("grok_health_capability_authorized");
        checks.capabilityAuthorized = true;
      } else {
        checks.capabilities = failed("grok_health_capability_missing", "Bootstrap or upgrade the daemon with the required health capability.");
      }
    } catch (error) {
      checks.daemonAuth = failed(publicFailure(error, "daemon_unreachable"), "Repair daemon credentials, protocol, or listener state.");
    }
  } else if (remoteDaemon && checks.secretSession.status === "fail") {
    checks.daemonAuth = skipped("daemon_auth_blocked_by_secret");
  } else if (remoteDaemon && checks.daemonHttp.status === "fail") {
    checks.daemonAuth = skipped("daemon_auth_blocked_by_http");
  }

  let discovery: Discovery | undefined;
  let health: Record<string, unknown> | undefined;
  const gatewayAllowed = !remoteDaemon || (checks.daemonAuth.status === "pass" && checks.capabilities.status === "pass");
  if (gatewayAllowed) {
    try {
      const runtimeDeps = daemonToken ? { ...deps, daemonToken } : deps;
      const result = await new GatewayClient(runtimeDeps).health(timeoutMs);
      discovery = result.discovery;
      health = healthProjection(result.health);
      const healthPid = asNumber(result.health.pid, Number.NaN);
      const healthStarted = asNumber(result.health.startedAt, Number.NaN);
      checks.gateway = asBoolean(result.health.ok)
        ? passed("gateway_healthy")
        : failed("gateway_unhealthy", "Inspect the in-box Gateway generation and health state.");
      checks.loopbackTarget = result.discovery.scheme === "unix" || isLoopbackHost(result.discovery.dialHost);
      checks.generationMatches = healthPid === result.discovery.pid && healthStarted === result.discovery.startedAt;
      checks.authenticatedCommand = "not-probed";
      checks.networkReachable = true;
    } catch (error) {
      checks.gateway = failed(publicFailure(error, "gateway_unreachable"), "Restore the daemon path or in-box Gateway, then retry doctor.");
    }
  } else {
    checks.gateway = skipped("gateway_probe_blocked_by_daemon_boundary");
  }

  if (
    remoteDaemon && checks.tailnet.code === "tailnet_peer_unreachable" &&
    checks.daemonHttp.status === "pass" && checks.daemonAuth.status === "pass" && checks.gateway.status === "pass"
  ) {
    checks.tailnet = { ...passed("tailnet_peer_reachable_via_daemon_https"), path: "reachable" };
    checks.tailnetIdentity = "verified";
  }

  const required = [checks.profile, checks.secretSession, checks.tailnet, checks.daemonHttp, checks.daemonAuth, checks.capabilities, checks.gateway];
  const ok = required.every((check) => check.status !== "fail") && (checks.serve.status !== "fail");
  return {
    ok,
    profile: { name: deps.profileName ?? "default", transport: deps.transport },
    ...(discovery ? { discovery: discoveryProjection(discovery) } : {}),
    ...(health ? { health } : {}),
    ...(handshake ? { daemon: daemonProjection(handshake) } : {}),
    checks,
  };
}
