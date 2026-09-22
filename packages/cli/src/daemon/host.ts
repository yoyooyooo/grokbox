import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { ALLOWED_EVENT_CHANNELS } from "../registry.ts";
import { acquireDaemonSocket, type DaemonSocketLease } from "@grokbox/box-runtime/runtime";
import { runtimeOwnershipReader } from "../runtime-ownership.ts";
import { asNumber, asString, isRecord } from "../util.ts";
import type { DaemonNetworkConfig } from "./config.ts";
import { liveDesktopIo, reapDeletedAgentSeat } from "@grokbox/box-runtime/runtime";
import { TitleSyncManager } from "./title-sync.ts";
import { DaemonEventManager, type EventSource } from "./events.ts";

import {
  DAEMON_CAPABILITIES,
  DAEMON_METHODS,
  DAEMON_PROTOCOL_MAJOR,
  type DaemonHandshake,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol.ts";

export type DaemonHost = {
  socketPath: string;
  network: { host: "127.0.0.1"; port: number } | null;
  handshake: () => Promise<DaemonHandshake>;
  close: () => Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new CliError("gateway_bad_request", "Daemon request exceeds 2 MiB.");
  }
  return body;
}

function writeResponse(res: ServerResponse, status: number, body: DaemonResponse): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function parseRequest(text: string): DaemonRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("gateway_bad_request", "Daemon request is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.protocolMajor !== DAEMON_PROTOCOL_MAJOR) {
    throw new CliError("daemon_protocol_mismatch", "Daemon protocol major is incompatible.");
  }
  if (typeof parsed.method !== "string" || !DAEMON_METHODS.includes(parsed.method as DaemonMethod)) {
    throw new CliError("gateway_not_found", "Daemon method is not allowlisted.");
  }
  if (!isRecord(parsed.params)) throw new CliError("gateway_bad_request", "Daemon params must be an object.");
  return { protocolMajor: DAEMON_PROTOCOL_MAJOR, method: parsed.method as DaemonMethod, params: parsed.params };
}

function assertParamKeys(params: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(params).sort()) !== JSON.stringify([...keys].sort())) {
    throw new CliError("gateway_bad_request", `${label} params are invalid.`);
  }
}

function gatewayBody(params: Record<string, unknown>): Record<string, unknown> {
  const body = { ...params };
  delete body.timeoutMs;
  return body;
}

function authorized(req: IncomingMessage, tokenSha256: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  const expected = Buffer.from(tokenSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function listenNetwork(server: Server, config: DaemonNetworkConfig): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new CliError("daemon_unreachable", "Daemon TCP listener has no address.");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startDaemonHost(
  deps: CliDeps,
  socketPath: string,
  networkConfig?: DaemonNetworkConfig,
): Promise<DaemonHost> {
  const startedAt = Date.now();
  const daemonGeneration = deps.randomUUID();
  const directDeps: CliDeps = { ...deps, transport: "local" };
  const events = new DaemonEventManager(daemonGeneration, directDeps, startedAt);
  const gateway = new GatewayClient(directDeps);
  const titleSync = new TitleSyncManager(gateway, deps.boxRuntimeRoot, deps.env);
  titleSync.start();

  const handshake = async (): Promise<DaemonHandshake> => {
    const discovery = await gateway.load();
    return {
      protocolMajor: DAEMON_PROTOCOL_MAJOR,
      daemonVersion: deps.cliVersion,
      daemonPid: process.pid,
      startedAt,
      daemonGeneration,
      capabilities: [
        ...DAEMON_CAPABILITIES,
        ...titleSync.capabilities(),
      ],
      gateway: gatewayMeta(discovery),
    };
  };

  const dispatch = async (
    method: DaemonMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (method === "handshake") return { result: await handshake() };
    if (method === "health") {
      const value = await gateway.health(asNumber(params.timeoutMs, 10_000));
      return { result: value.health, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "listAgents") {
      const value = await gateway.listAgents(asNumber(params.timeoutMs, 10_000));
      return { result: value.agents, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "searchAgents") {
      const value = await gateway.searchAgents(
        asString(params.query),
        asNumber(params.limit, 20),
        asNumber(params.timeoutMs, 10_000),
      );
      return { result: value.matches, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getAgentTranscriptTail") {
      const beforeSeq = typeof params.beforeSeq === "number" ? params.beforeSeq : undefined;
      const value = await gateway.getAgentTranscriptTail(
        {
          id: asString(params.id),
          limit: asNumber(params.limit, 50),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        },
        asNumber(params.timeoutMs, 10_000),
      );
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getAgentThread") {
      const value = await gateway.getAgentThread(
        { id: asString(params.id), rootId: asString(params.rootId) },
        asNumber(params.timeoutMs, 10_000),
      );
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getAgentOwnership") {
      assertParamKeys(params, ["agentIds", "timeoutMs"], "getAgentOwnership");
      if (!Array.isArray(params.agentIds) || params.agentIds.some(id => typeof id !== "string")) {
        throw new CliError("invalid_usage", "Ownership requires an Agent UUID array.");
      }
      const value = await gateway.getAgentOwnership(params.agentIds as string[], asNumber(params.timeoutMs, 15_000));
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getTrays") {
      assertParamKeys(params, ["timeoutMs"], "getTrays");
      const value = await gateway.getTrays(asNumber(params.timeoutMs, 10_000));
      return { result: value.trays, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "sendPrompt") {
      const value = await gateway.sendPrompt(
        {
          agentId: asString(params.agentId),
          prompt: asString(params.prompt),
          clientNonce: asString(params.clientNonce),
        },
        asNumber(params.timeoutMs, 10_000),
      );
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    const timeoutMs = asNumber(params.timeoutMs, 10_000);
    const body = gatewayBody(params);
    if (method === "createAgent") {
      const value = await gateway.createAgent(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "createGroup") {
      const value = await gateway.createGroup(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "updateAgent") {
      const value = await gateway.updateAgent(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "setGroupMembers") {
      const value = await gateway.setGroupMembers(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "setAgentNotifyOnUpdates") {
      const value = await gateway.setAgentNotifyOnUpdates(
        { id: asString(body.id), isEnabled: body.isEnabled === true },
        timeoutMs,
      );
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "setAgentHiddenFromSidebar") {
      const value = await gateway.setAgentHiddenFromSidebar(
        { id: asString(body.id), isHidden: body.isHidden === true },
        timeoutMs,
      );
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "deleteAgent") {
      const value = await gateway.deleteAgent(asString(body.id), timeoutMs);
      const seatIo = deps.desktopIo ?? await liveDesktopIo();
      const desktopReap = seatIo ? await reapDeletedAgentSeat(asString(body.id), deps.now(), seatIo) : { display: null, outcome: "unavailable" };
      const result = isRecord(value.result) ? { ...value.result, desktop: desktopReap } : { desktop: desktopReap };
      return { result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "publishBotTemplate") {
      const value = await gateway.publishBotTemplate(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getBotTemplateVersion") {
      const value = await gateway.getBotTemplateVersion(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "getBotTemplateForSourceAgent") {
      const value = await gateway.getBotTemplateForSourceAgent(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "deleteBotTemplate") {
      const value = await gateway.deleteBotTemplate(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "setBotTemplateVisibility") {
      const value = await gateway.setBotTemplateVisibility(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "createAgentFromTemplate") {
      const value = await gateway.createAgentFromTemplate(body, timeoutMs);
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "eventRead") {
      assertParamKeys(params, ["channels", "cursor", "includeMemoryContent", "limit", "sources", "waitMs"], "Event read");
      const allowedSources = new Set<EventSource>(["gateway", "daemon"]);
      if ((params.cursor !== null && typeof params.cursor !== "string") ||
        !Array.isArray(params.sources) || params.sources.length === 0 ||
        params.sources.some((source) => typeof source !== "string" || !allowedSources.has(source as EventSource)) ||
        new Set(params.sources).size !== params.sources.length ||
        !Array.isArray(params.channels) || params.channels.length === 0 ||
        params.channels.some((channel) => typeof channel !== "string" || !ALLOWED_EVENT_CHANNELS.includes(channel as (typeof ALLOWED_EVENT_CHANNELS)[number])) ||
        new Set(params.channels).size !== params.channels.length || typeof params.includeMemoryContent !== "boolean" ||
        typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 128 ||
        typeof params.waitMs !== "number" || !Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > 25_000) {
        throw new CliError("gateway_bad_request", "Event read params are invalid.");
      }
      return { result: await events.read({
        ...(params.cursor === null ? {} : { cursor: params.cursor as string }),
        sources: params.sources as EventSource[],
        channels: params.channels as string[],
        includeMemoryContent: params.includeMemoryContent,
        limit: params.limit,
        waitMs: params.waitMs,
        signal,
      }) };
    }
    throw new CliError("gateway_not_found", "Daemon method is not implemented.");
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    requiresCredential: boolean,
  ): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/v1/rpc") {
      writeResponse(res, 404, { ok: false, error: { code: "gateway_not_found", message: "Not found.", retryable: false } });
      return;
    }
    if (requiresCredential && (!networkConfig || !authorized(req, networkConfig.tokenSha256))) {
      writeResponse(res, 401, {
        ok: false,
        error: { code: "daemon_unauthorized", message: "Daemon rejected the shared credential.", retryable: false },
      });
      return;
    }
    try {
      const request = parseRequest(await readBody(req));
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      const response = await dispatch(request.method, request.params, controller.signal);
      writeResponse(res, 200, { ok: true, ...response });
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError("gateway_internal", "Daemon request failed.");
      writeResponse(res, cliError.code === "daemon_protocol_mismatch" ? 409 : 400, {
        ok: false,
        error: { code: cliError.code, message: cliError.message, retryable: cliError.retryable },
      });
    }
  };

  const localServer = createServer((req, res) => { void handle(req, res, false); });
  const networkServer = networkConfig
    ? createServer((req, res) => { void handle(req, res, true); })
    : null;

  let networkPort: number | null = null;
  let socketLease: DaemonSocketLease | undefined;
  try {
    socketLease = await acquireDaemonSocket(socketPath, daemonGeneration);
    await listenUnix(localServer, socketPath);
    await chmod(socketPath, 0o600);
    await socketLease.recordBound();
    if (networkServer && networkConfig) networkPort = await listenNetwork(networkServer, networkConfig);
  } catch (error) {
    await Promise.allSettled([
      closeServer(localServer),
      ...(networkServer ? [closeServer(networkServer)] : []),
      events.close(), titleSync.close(),
    ]);
    await socketLease?.release();
    throw error;
  }


  return {
    socketPath,
    network: networkPort === null ? null : { host: "127.0.0.1", port: networkPort },
    handshake,
    close: async () => {
      // Stop all producers before delivery shutdown. Each child settles its
      // transactions before the enclosing listeners and socket owner disappear.
      const lifecycleFailures: unknown[] = [];
      for (const close of [() => events.close()]) {
        try { await close(); } catch (error) { lifecycleFailures.push(error); }
      }
      const results = await Promise.allSettled([
        closeServer(localServer),
        ...(networkServer ? [closeServer(networkServer)] : []),
        titleSync.close(),
      ]);
      try { await socketLease?.release(); } catch (error) { lifecycleFailures.push(error); }
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (lifecycleFailures.length) throw lifecycleFailures[0];
      if (rejected) throw rejected.reason;
    },
  };
}
