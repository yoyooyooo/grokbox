import { createHash } from "node:crypto";
import { resolveDaemonCredential, resolveSecretRef } from "./config/secret.ts";
import type { CliDeps } from "./deps.ts";
import {
  LocalDaemonClient,
  RemoteDaemonClient,
  type DaemonClient,
} from "./daemon/client.ts";
import { CliError, httpStatusToError } from "./errors.ts";
import type { GatewayMethod } from "./registry.ts";
import { isRecord } from "./util.ts";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

export type Discovery = {
  scheme: string;
  bindHost: string;
  dialHost: string;
  port: number;
  pid: number;
  startedAt: number;
  token: string;
  tokenPresent: boolean;
  baseUrl: string;
};

export type GatewayMeta = { pid: number; startedAt: number };

type RequestKind = "read" | "write" | "health";
type UnknownOutcomeCode = "send_delivery_unknown" | "operation_outcome_unknown";

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function resolveDialHost(bindHost: string): string {
  const host = bindHost.trim();
  if (host.length === 0) {
    throw new CliError("discovery_unavailable", "Discovery host is missing.");
  }
  if (isWildcardHost(host)) return "127.0.0.1";
  if (isLoopbackHost(host)) {
    if (host.toLowerCase() === "localhost") return "127.0.0.1";
    return host;
  }
  throw new CliError(
    "discovery_unavailable",
    "Discovery host is not loopback; grokbox refuses to dial off-box.",
  );
}

export async function readDiscovery(deps: CliDeps): Promise<Discovery> {
  let raw: string;
  try {
    raw = await deps.readFile(deps.discoveryPath);
  } catch {
    throw new CliError("discovery_unavailable", "Gateway discovery file is missing or unreadable.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("discovery_unavailable", "Gateway discovery file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new CliError("discovery_unavailable", "Gateway discovery file has the wrong shape.");
  }
  const scheme = parsed.scheme;
  const host = parsed.host;
  const port = parsed.port;
  const pid = parsed.pid;
  const startedAt = parsed.startedAt;
  const token = parsed.token;
  if (scheme !== "http" && scheme !== "https") {
    throw new CliError("discovery_unavailable", "Discovery scheme must be http or https.");
  }
  if (typeof host !== "string") {
    throw new CliError("discovery_unavailable", "Discovery host is missing.");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("discovery_unavailable", "Discovery port is invalid.");
  }
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    throw new CliError("discovery_unavailable", "Discovery pid is invalid.");
  }
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    throw new CliError("discovery_unavailable", "Discovery startedAt is invalid.");
  }
  if (typeof token !== "string") {
    throw new CliError("discovery_unavailable", "Discovery token is invalid.");
  }
  const dialHost = resolveDialHost(host);
  return {
    scheme,
    bindHost: host,
    dialHost,
    port,
    pid,
    startedAt,
    token,
    tokenPresent: token.length > 0,
    baseUrl: `${scheme}://${formatHostForUrl(dialHost)}:${port}`,
  };
}

export function gatewayMeta(discovery: Discovery): GatewayMeta {
  return { pid: discovery.pid, startedAt: discovery.startedAt };
}

function parseFailureCode(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.failureCode !== "string") return undefined;
  return body.failureCode;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

type HttpResult = {
  status: number;
  body: unknown;
  text: string;
  response: Response;
};

export class GatewayClient {
  lastDiscovery: Discovery | null = null;
  private lastDaemonRemote = false;
  private selectedGateway: "local" | "explicit" | null = null;
  private gatewayHeaders: Record<string, string> = {};

  constructor(private readonly deps: CliDeps) {}

  private discoveryFromDaemon(gateway: { pid: number; startedAt: number }): Discovery {
    if (this.lastDaemonRemote && this.deps.daemonServerUrl) {
      const endpoint = new URL(this.deps.daemonServerUrl);
      return {
        scheme: endpoint.protocol.replace(":", ""),
        bindHost: endpoint.hostname,
        dialHost: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
        pid: gateway.pid,
        startedAt: gateway.startedAt,
        token: "",
        tokenPresent: false,
        baseUrl: this.deps.daemonServerUrl,
      };
    }
    return {
      scheme: "unix",
      bindHost: this.deps.daemonSocket,
      dialHost: this.deps.daemonSocket,
      port: 0,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: "",
      tokenPresent: false,
      baseUrl: "unix://local-daemon",
    };
  }

  private async remoteDaemon(timeoutMs: number): Promise<RemoteDaemonClient> {
    if (!this.deps.daemonServerUrl) {
      throw new CliError("daemon_endpoint_unavailable", "The remote daemon endpoint is not configured.");
    }
    const token = this.deps.daemonToken ?? await resolveDaemonCredential(
      this.deps,
      this.deps.daemonTokenRef,
    );
    return new RemoteDaemonClient(
      this.deps.daemonServerUrl,
      token,
      timeoutMs,
      this.deps.fetch,
      this.deps.signal,
    );
  }

  private async requireCapability(
    client: DaemonClient,
    capability: string,
    allowUnavailableCapability: boolean,
  ): Promise<DaemonClient | null> {
    const handshake = await client.handshake();
    if (!handshake.capabilities.includes(capability)) {
      if (allowUnavailableCapability) return null;
      throw new CliError("capability_unavailable", `Daemon does not provide ${capability}.`);
    }
    return client;
  }

  private async daemonFor(capability: string, timeoutMs: number): Promise<DaemonClient | null> {
    if (this.deps.transport === "local") {
      this.selectedGateway = "local";
      return null;
    }
    if (this.deps.transport === "gateway") {
      this.selectedGateway = this.deps.gatewayServerUrl ? "explicit" : "local";
      return null;
    }
    if (this.deps.transport === "daemon") {
      this.lastDaemonRemote = Boolean(this.deps.daemonServerUrl);
      const client = this.deps.daemonServerUrl
        ? await this.remoteDaemon(timeoutMs)
        : new LocalDaemonClient(this.deps.daemonSocket, timeoutMs, this.deps.signal);
      return await this.requireCapability(client, capability, false);
    }

    try {
      const local = await this.requireCapability(
        new LocalDaemonClient(this.deps.daemonSocket, timeoutMs, this.deps.signal),
        capability,
        true,
      );
      if (local) {
        this.lastDaemonRemote = false;
        return local;
      }
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "daemon_unreachable") throw error;
    }

    if (capability.startsWith("grok.")) {
      try {
        await readDiscovery(this.deps);
        this.selectedGateway = "local";
        return null;
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "discovery_unavailable") throw error;
      }
    }

    if (this.deps.daemonServerUrl) {
      this.lastDaemonRemote = true;
      return await this.requireCapability(await this.remoteDaemon(timeoutMs), capability, false);
    }
    if (this.deps.gatewayServerUrl) this.selectedGateway = "explicit";
    return null;
  }

  async daemonCapability(capability: string, timeoutMs: number): Promise<DaemonClient> {
    const client = await this.daemonFor(capability, timeoutMs);
    if (!client) throw new CliError("capability_unavailable", `Selected Profile does not provide ${capability}.`);
    return client;
  }

  private async loadExplicitGateway(): Promise<Discovery> {
    const endpoint = new URL(this.deps.gatewayServerUrl!);
    let token = "";
    let pid = 0;
    let startedAt = 0;
    if (this.deps.gatewayTokenRef) {
      token = await resolveSecretRef(this.deps, this.deps.gatewayTokenRef);
    } else if (this.deps.sshHost) {
      const result = await this.deps.runCommand([
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        this.deps.sshHost,
        "cat /home/box/sand-data/gateway.json",
      ]);
      if (result.code !== 0) {
        throw new CliError("discovery_unavailable", "Explicit SSH Gateway discovery is unavailable.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new CliError("discovery_unavailable", "Explicit SSH Gateway discovery returned invalid JSON.");
      }
      if (!isRecord(parsed) || typeof parsed.token !== "string") {
        throw new CliError("discovery_unavailable", "Explicit SSH Gateway discovery lacks a token.");
      }
      token = parsed.token;
      pid = typeof parsed.pid === "number" ? parsed.pid : 0;
      startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : 0;
    } else {
      throw new CliError("credential_unavailable", "Explicit remote Gateway requires a token reference or ssh_host discovery.");
    }

    this.gatewayHeaders = {};
    if (this.deps.gatewayHeadersRef) {
      const raw = await resolveSecretRef(this.deps, this.deps.gatewayHeadersRef);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CliError("credential_invalid", "Gateway headers reference must contain a JSON object.");
      }
      if (!isRecord(parsed)) throw new CliError("credential_invalid", "Gateway headers reference must contain a JSON object.");
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== "string" || /^(authorization|origin|host|content-length)$/i.test(name)) {
          throw new CliError("credential_invalid", "Gateway headers reference contains a forbidden header.");
        }
        this.gatewayHeaders[name] = value;
      }
    }

    return {
      scheme: endpoint.protocol.replace(":", ""),
      bindHost: endpoint.hostname,
      dialHost: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
      pid,
      startedAt,
      token,
      tokenPresent: token.length > 0,
      baseUrl: this.deps.gatewayServerUrl!,
    };
  }

  async load(): Promise<Discovery> {
    let discovery: Discovery;
    if (this.selectedGateway === "explicit") {
      discovery = await this.loadExplicitGateway();
    } else if (this.selectedGateway === "local" || this.deps.transport === "local") {
      discovery = await readDiscovery(this.deps);
    } else if (this.deps.transport === "gateway" && this.deps.gatewayServerUrl) {
      this.selectedGateway = "explicit";
      discovery = await this.loadExplicitGateway();
    } else {
      try {
        discovery = await readDiscovery(this.deps);
        this.selectedGateway = "local";
      } catch (error) {
        if (!this.deps.gatewayServerUrl) throw error;
        this.selectedGateway = "explicit";
        discovery = await this.loadExplicitGateway();
      }
    }
    this.lastDiscovery = discovery;
    return discovery;
  }

  requireToken(discovery: Discovery): void {
    if (!discovery.tokenPresent) {
      throw new CliError("discovery_unavailable", "Discovery token is missing.");
    }
  }

  async health(timeoutMs: number): Promise<{ discovery: Discovery; health: Record<string, unknown> }> {
    const daemon = await this.daemonFor("grok.health.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("health", { timeoutMs });
      if (!isRecord(response.result) || !response.gateway) {
        throw new CliError("gateway_internal", "Daemon health response has the wrong shape.");
      }
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { discovery, health: response.result };
    }
    const result = await this.request({
      kind: "health",
      path: "/health",
      method: "GET",
      auth: false,
      timeoutMs,
    });
    if (!isRecord(result.body)) {
      throw new CliError("gateway_internal", "Gateway /health did not return an object.", {
        httpStatus: result.status,
      });
    }
    return { discovery: this.lastDiscovery!, health: result.body };
  }

  async rpc(
    method: GatewayMethod,
    body: Record<string, unknown>,
    options: {
      timeoutMs: number;
      write?: boolean;
      slim?: boolean;
      unknownOutcomeCode?: UnknownOutcomeCode;
    },
  ): Promise<{ result: unknown; discovery: Discovery }> {
    const result = await this.request({
      kind: options.write ? "write" : "read",
      path: `/api/${method}`,
      method: "POST",
      auth: true,
      timeoutMs: options.timeoutMs,
      jsonBody: body,
      slim: options.slim === true,
      write: options.write === true,
      unknownOutcomeCode: options.unknownOutcomeCode,
    });
    return { result: result.body, discovery: this.lastDiscovery! };
  }

  async listAgents(timeoutMs: number): Promise<{ agents: unknown[]; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.roster.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("listAgents", { timeoutMs });
      if (!Array.isArray(response.result) || !response.gateway) {
        throw new CliError("gateway_internal", "Daemon listAgents response has the wrong shape.");
      }
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { agents: response.result, discovery };
    }
    const { result, discovery } = await this.rpc("listAgents", {}, { timeoutMs, slim: true });
    if (!Array.isArray(result)) {
      throw new CliError("gateway_internal", "Gateway listAgents did not return an array.");
    }
    return { agents: result, discovery };
  }

  async searchAgents(
    query: string,
    limit: number,
    timeoutMs: number,
  ): Promise<{ matches: unknown[]; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.transcript.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("searchAgents", { query, limit, timeoutMs });
      if (!Array.isArray(response.result) || !response.gateway) {
        throw new CliError("gateway_internal", "Daemon searchAgents response has the wrong shape.");
      }
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { matches: response.result, discovery };
    }
    const { result, discovery } = await this.rpc("searchAgents", { query, limit }, { timeoutMs });
    if (!Array.isArray(result)) {
      throw new CliError("gateway_internal", "Gateway searchAgents did not return an array.");
    }
    return { matches: result, discovery };
  }

  async getAgentTranscriptTail(
    body: { id: string; limit: number; beforeSeq?: number },
    timeoutMs: number,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.transcript.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("getAgentTranscriptTail", { ...body, timeoutMs });
      if (!response.gateway) throw new CliError("gateway_internal", "Daemon tail response lacks generation.");
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { result: response.result, discovery };
    }
    const payload: Record<string, unknown> = { id: body.id, limit: body.limit };
    if (body.beforeSeq !== undefined) payload.beforeSeq = body.beforeSeq;
    return await this.rpc("getAgentTranscriptTail", payload, { timeoutMs });
  }

  async getAgentThread(
    body: { id: string; rootId: string },
    timeoutMs: number,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.transcript.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("getAgentThread", { ...body, timeoutMs });
      if (!response.gateway) throw new CliError("gateway_internal", "Daemon thread response lacks generation.");
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { result: response.result, discovery };
    }
    return await this.rpc("getAgentThread", { id: body.id, rootId: body.rootId }, { timeoutMs });
  }

  async getAgentMemories(id: string, timeoutMs: number): Promise<{ result: unknown; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.memory.read", timeoutMs);
    if (daemon) {
      const response = await daemon.call("getAgentMemories", { id, timeoutMs });
      if (!response.gateway) throw new CliError("gateway_internal", "Daemon Memory response lacks generation.");
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { result: response.result, discovery };
    }
    return await this.rpc("getAgentMemories", { id }, { timeoutMs });
  }

  async sendPrompt(
    body: { agentId: string; prompt: string; clientNonce: string },
    timeoutMs: number,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    const daemon = await this.daemonFor("grok.transcript.write", timeoutMs);
    if (daemon) {
      const response = await daemon.call("sendPrompt", { ...body, timeoutMs });
      if (!response.gateway) throw new CliError("gateway_internal", "Daemon send response lacks generation.");
      const discovery = this.discoveryFromDaemon(response.gateway);
      this.lastDiscovery = discovery;
      return { result: response.result, discovery };
    }
    return await this.rpc(
      "sendPrompt",
      { agentId: body.agentId, prompt: body.prompt, clientNonce: body.clientNonce },
      { timeoutMs, write: true, unknownOutcomeCode: "send_delivery_unknown" },
    );
  }

  async createAgent(
    body: Record<string, unknown>,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("createAgent", body, timeoutMs, operationId);
  }

  async createGroup(
    body: Record<string, unknown>,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("createGroup", body, timeoutMs, operationId);
  }

  async updateAgent(
    body: Record<string, unknown>,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("updateAgent", body, timeoutMs, operationId);
  }

  async setGroupMembers(
    body: Record<string, unknown>,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("setGroupMembers", body, timeoutMs, operationId);
  }

  async setAgentNotifyOnUpdates(
    body: { id: string; isEnabled: boolean },
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("setAgentNotifyOnUpdates", body, timeoutMs, operationId);
  }

  async setAgentHiddenFromSidebar(
    body: { id: string; isHidden: boolean },
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("setAgentHiddenFromSidebar", body, timeoutMs, operationId);
  }

  async deleteAgent(
    id: string,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    return await this.managementWrite("deleteAgent", { id }, timeoutMs, operationId);
  }

  private async managementWrite(
    method: Extract<GatewayMethod,
      | "createAgent"
      | "createGroup"
      | "updateAgent"
      | "setGroupMembers"
      | "setAgentNotifyOnUpdates"
      | "setAgentHiddenFromSidebar"
      | "deleteAgent">,
    body: Record<string, unknown>,
    timeoutMs: number,
    operationId?: string,
  ): Promise<{ result: unknown; discovery: Discovery }> {
    try {
      const daemon = await this.daemonFor("grok.roster.write", timeoutMs);
      if (daemon) {
        const response = await daemon.call(method, { ...body, timeoutMs });
        if (!response.gateway) throw new CliError("gateway_internal", "Daemon management response lacks generation.");
        const discovery = this.discoveryFromDaemon(response.gateway);
        this.lastDiscovery = discovery;
        return { result: response.result, discovery };
      }
      return await this.rpc(method, body, {
        timeoutMs,
        write: true,
        slim: true,
        unknownOutcomeCode: "operation_outcome_unknown",
      });
    } catch (error) {
      if (operationId && error instanceof CliError && error.code === "operation_outcome_unknown") {
        throw new CliError("operation_outcome_unknown", error.message, { context: { operationId } });
      }
      throw error;
    }
  }

  async eventDaemon(timeoutMs: number): Promise<DaemonClient | null> {
    return await this.daemonFor("grok.events.read", timeoutMs);
  }

  async openEventStream(
    channels: string[],
    timeoutMs: number,
  ): Promise<{ response: Response; discovery: Discovery }> {
    const qs = channels.map((c) => encodeURIComponent(c)).join(",");
    const result = await this.request({
      kind: "read",
      path: `/events?channels=${qs}`,
      method: "GET",
      auth: true,
      timeoutMs,
      slim: true,
      accept: "text/event-stream",
      stream: true,
    });
    return { response: result.response, discovery: this.lastDiscovery! };
  }

  private async request(input: {
    kind: RequestKind;
    path: string;
    method: "GET" | "POST";
    auth: boolean;
    timeoutMs: number;
    jsonBody?: Record<string, unknown>;
    slim?: boolean;
    write?: boolean;
    unknownOutcomeCode?: UnknownOutcomeCode;
    accept?: string;
    stream?: boolean;
  }): Promise<HttpResult> {
    const serialized = input.jsonBody === undefined ? undefined : JSON.stringify(input.jsonBody);
    const write = input.write === true;
    let attemptedIdentity: string | undefined;
    const attempt = async (rejectIdentity?: string): Promise<HttpResult> => {
      const discovery = await this.load();
      const identity = createHash("sha256")
        .update(discovery.token)
        .digest("hex");
      if (rejectIdentity !== undefined && identity === rejectIdentity) {
        throw new CliError("gateway_unauthorized", "Gateway credential did not rotate after rejection.");
      }
      attemptedIdentity = identity;
      if (input.auth) this.requireToken(discovery);
      return await this.sendOnce(
        discovery,
        input,
        serialized,
        write,
        input.unknownOutcomeCode ?? "operation_outcome_unknown",
      );
    };

    try {
      return await this.interpret(await attempt());
    } catch (error) {
      if (error instanceof CliError && error.code === "gateway_unauthorized") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return await this.interpret(await attempt(attemptedIdentity));
      }
      if (error instanceof CliError && error.code === "gateway_unreachable") {
        return await this.interpret(await attempt());
      }
      throw error;
    }
  }

  private async sendOnce(
    discovery: Discovery,
    input: {
      path: string;
      method: "GET" | "POST";
      auth: boolean;
      timeoutMs: number;
      slim?: boolean;
      accept?: string;
      stream?: boolean;
    },
    serialized: string | undefined,
    write: boolean,
    unknownOutcomeCode: UnknownOutcomeCode,
  ): Promise<HttpResult> {
    const headers = new Headers();
    if (input.auth) headers.set("Authorization", `Bearer ${discovery.token}`);
    if (serialized !== undefined) headers.set("Content-Type", "application/json");
    headers.set("Accept", input.accept ?? "application/json");
    if (input.slim) headers.set("x-sand-slim-avatars", "1");
    for (const [name, value] of Object.entries(this.gatewayHeaders)) headers.set(name, value);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await this.deps.fetch(`${discovery.baseUrl}${input.path}`, {
        method: input.method,
        headers,
        body: serialized,
        signal: ac.signal,
        redirect: "manual",
      });
    } catch (error) {
      clearTimeout(timer);
      if (isAbortError(error)) {
        if (write) {
          throw new CliError(
            unknownOutcomeCode,
            "The write may have reached Gateway before the response was lost.",
          );
        }
        throw new CliError("gateway_unreachable", "Gateway request timed out.");
      }
      if (write) {
        throw new CliError(
          unknownOutcomeCode,
          "The write may have reached Gateway before the response was lost.",
        );
      }
      throw new CliError("gateway_unreachable", "Gateway is unreachable.", {
        retryable: true,
      });
    }
    if (input.stream) {
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text.length === 0 ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        throw httpStatusToError(response.status, parseFailureCode(parsed), "Gateway request failed.");
      }
      return { status: response.status, body: null, text: "", response };
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      if (write) {
        throw new CliError(
          unknownOutcomeCode,
          "The write may have reached Gateway before the response was lost.",
        );
      }
      throw new CliError("gateway_unreachable", "Gateway is unreachable.");
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text, response };
  }

  private interpret(result: HttpResult): HttpResult {
    if (result.status >= 200 && result.status < 300) return result;
    throw httpStatusToError(result.status, parseFailureCode(result.body), "Gateway request failed.");
  }
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: { onChunk?: () => void; onGap?: (reason: "malformed_frame" | "frame_too_large") => void; signal?: AbortSignal } = {},
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const abort = () => {
    void reader.cancel();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0 && !buf.endsWith("\n\n")) buf += "\n\n";
      } else {
        options.onChunk?.();
        buf += decoder.decode(value, { stream: true });
      }
      buf = buf.replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buf) > 1024 * 1024) {
        options.onGap?.("frame_too_large");
        await reader.cancel();
        return;
      }
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length > 0) {
          if (Buffer.byteLength(data) > 256 * 1024) {
            options.onGap?.("frame_too_large");
          } else {
            try {
              yield JSON.parse(data) as unknown;
            } catch {
              options.onGap?.("malformed_frame");
            }
          }
        }
        idx = buf.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
