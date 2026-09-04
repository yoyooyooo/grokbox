import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { ALLOWED_EVENT_CHANNELS } from "../registry.ts";
import { asNumber, asString, isRecord } from "../util.ts";
import type { DaemonDesktopConfig, DaemonFilesystemRootConfig, DaemonNetworkConfig, DaemonProcessConfig } from "./config.ts";
import { DesktopManager, type DesktopIo } from "./desktop.ts";
import { DaemonEventManager, type EventSource } from "./events.ts";
import { JobManager, type JobState, type JobSubmit } from "./jobs.ts";
import { ProcessAuthority } from "./process.ts";
import { GovernedFilesystem } from "./filesystem.ts";
import {
  DAEMON_CAPABILITIES,
  DAEMON_METHODS,
  DAEMON_PROTOCOL_MAJOR,
  type DaemonHandshake,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function assertExactParams(
  params: Record<string, unknown>,
  required: Readonly<Record<string, "string" | "number" | "boolean">>,
  optional: Readonly<Record<string, "string" | "number" | "boolean">> = {},
): void {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  if (Object.keys(params).some((key) => !allowed.has(key))) {
    throw new CliError("gateway_bad_request", "Daemon mutation params contain unsupported fields.");
  }
  for (const [key, type] of Object.entries(required)) {
    if (!(key in params) || typeof params[key] !== type ||
      (type === "number" && !Number.isFinite(params[key]))) {
      throw new CliError("gateway_bad_request", `Daemon mutation param '${key}' is invalid.`);
    }
  }
  for (const [key, type] of Object.entries(optional)) {
    if (key in params && (typeof params[key] !== type ||
      (type === "number" && !Number.isFinite(params[key])))) {
      throw new CliError("gateway_bad_request", `Daemon mutation param '${key}' is invalid.`);
    }
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
  filesystemRoots: readonly DaemonFilesystemRootConfig[] = [],
  processConfig?: DaemonProcessConfig,
  desktopConfig?: DaemonDesktopConfig,
  desktopIo?: DesktopIo,
): Promise<DaemonHost> {
  const startedAt = Date.now();
  const daemonGeneration = deps.randomUUID();
  const filesystem = await GovernedFilesystem.create(filesystemRoots, deps.now);
  const processAuthority = processConfig ? await ProcessAuthority.create(processConfig) : null;
  const directDeps: CliDeps = { ...deps, transport: "local" };
  const events = new DaemonEventManager(daemonGeneration, directDeps, startedAt);
  const jobs = processAuthority ? await JobManager.create(
    deps.configDir,
    processAuthority,
    filesystem,
    deps.now,
    daemonGeneration,
    (event) => events.publishJob(event),
  ) : null;
  const gateway = new GatewayClient(directDeps);
  const desktop = await DesktopManager.create(deps.configDir, deps.now, desktopConfig, desktopIo);

  const handshake = async (): Promise<DaemonHandshake> => {
    const discovery = await gateway.load();
    const roots = filesystem.projections();
    const hasRead = roots.some((root) => root.operations.some((operation) =>
      ["stat", "list", "read", "download"].includes(operation)));
    const hasWrite = roots.some((root) => root.operations.some((operation) =>
      ["write", "mkdir", "upload", "remove", "remove-recursive"].includes(operation)));
    const hasRecursiveRemove = roots.some((root) => root.operations.includes("remove-recursive"));
    return {
      protocolMajor: DAEMON_PROTOCOL_MAJOR,
      daemonVersion: deps.cliVersion,
      daemonPid: process.pid,
      startedAt,
      daemonGeneration,
      capabilities: [
        ...DAEMON_CAPABILITIES,
        ...(hasRead ? ["host.fs.read"] : []),
        ...(hasWrite ? ["host.fs.write"] : []),
        ...(hasRecursiveRemove ? ["host.fs.remove.recursive"] : []),
        ...(jobs?.capabilities() ?? []),
        ...desktop.capabilities(),
      ],
      filesystemRoots: roots,
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
    if (method === "getAgentMemories") {
      const value = await gateway.getAgentMemories(asString(params.id), asNumber(params.timeoutMs, 10_000));
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
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
      return { result: value.result, gateway: gatewayMeta(value.discovery) };
    }
    if (method === "fsStat") {
      return { result: await filesystem.stat(asString(params.path), signal) };
    }
    if (method === "fsList") {
      return { result: await filesystem.list(asString(params.path)) };
    }
    if (method === "fsRead") {
      return { result: await filesystem.read(asString(params.path), signal) };
    }
    if (method === "fsDownloadOpen") {
      return {
        result: await filesystem.openDownload(
          asString(params.path),
          asString(params.transferId),
          signal,
        ),
      };
    }
    if (method === "fsDownloadChunk") {
      return {
        result: await filesystem.downloadChunk(
          asString(params.transferId),
          typeof params.index === "number" ? params.index : Number.NaN,
        ),
      };
    }
    if (method === "fsDownloadCancel") {
      return { result: await filesystem.cancelDownload(asString(params.transferId)) };
    }
    if (method === "fsWrite") {
      assertExactParams(
        params,
        { operationId: "string", path: "string", contentUtf8: "string" },
        { expectedSha256: "string" },
      );
      return { result: await filesystem.write(
        params.operationId as string,
        params.path as string,
        Buffer.from(params.contentUtf8 as string, "utf8"),
        params.expectedSha256 as string | undefined,
      ) };
    }
    if (method === "fsMkdir") {
      assertExactParams(params, { operationId: "string", path: "string" });
      return { result: await filesystem.makeDirectory(params.operationId as string, params.path as string) };
    }
    if (method === "fsUploadOpen") {
      assertExactParams(
        params,
        { operationId: "string", path: "string", size: "number", sha256: "string" },
        { expectedSha256: "string" },
      );
      return { result: await filesystem.openUpload(
        params.operationId as string,
        params.path as string,
        params.size as number,
        params.sha256 as string,
        params.expectedSha256 as string | undefined,
      ) };
    }
    if (method === "fsUploadChunk") {
      assertExactParams(params, {
        operationId: "string", index: "number", bytes: "number", contentBase64: "string",
      });
      const contentBase64 = params.contentBase64 as string;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
        throw new CliError("fs_upload_invalid", "Upload chunk is not valid base64.");
      }
      const content = Buffer.from(contentBase64, "base64");
      if (params.bytes !== content.length) throw new CliError("fs_upload_invalid", "Upload chunk byte count is invalid.");
      return { result: await filesystem.uploadChunk(
        params.operationId as string,
        params.index as number,
        content,
      ) };
    }
    if (method === "fsUploadCommit") {
      assertExactParams(params, { operationId: "string" });
      return { result: await filesystem.commitUpload(params.operationId as string) };
    }
    if (method === "fsUploadCancel") {
      assertExactParams(params, { operationId: "string" });
      return { result: await filesystem.cancelUpload(params.operationId as string) };
    }
    if (method === "fsRemove") {
      assertExactParams(params, { operationId: "string", path: "string", recursive: "boolean" });
      return { result: await filesystem.remove(
        params.operationId as string,
        params.path as string,
        params.recursive as boolean,
      ) };
    }
    if (method === "fsMutationStatus") {
      assertExactParams(params, { operationId: "string" });
      return { result: filesystem.mutationStatus(params.operationId as string) };
    }
    if (method === "jobSubmit") {
      if (!jobs) throw new CliError("capability_unavailable", "Process execution is not configured.");
      const fields = ["argv", "cwd", "environment", "expectedDaemonGeneration", "jobId", "output", "runTimeoutMs", "shell", "waitMs"];
      assertParamKeys(params, fields, "Job submission");
      if (
        !Array.isArray(params.argv) || params.argv.some((value) => typeof value !== "string") ||
        (params.cwd !== null && typeof params.cwd !== "string") || !isRecord(params.environment) || Object.values(params.environment).some((value) => typeof value !== "string") ||
        typeof params.jobId !== "string" || typeof params.expectedDaemonGeneration !== "string" ||
        !UUID_V4.test(params.expectedDaemonGeneration) ||
        (params.output !== "capture" && params.output !== "discard") ||
        typeof params.runTimeoutMs !== "number" || typeof params.shell !== "boolean" ||
        typeof params.waitMs !== "number" || !Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > 300_000) {
        throw new CliError("gateway_bad_request", "Job submission params are invalid.");
      }
      if (params.expectedDaemonGeneration !== daemonGeneration) {
        throw new CliError("operation_outcome_unknown", "Daemon generation changed before Job submission admission.", {
          context: { operationId: params.jobId },
        });
      }
      const request: JobSubmit = {
        jobId: params.jobId, cwd: params.cwd === null ? undefined : params.cwd as string, argv: params.argv as string[],
        environment: params.environment as Record<string, string>, runTimeoutMs: params.runTimeoutMs,
        output: params.output, shell: params.shell,
      };
      const submitted = await jobs.submit(request);
      return { result: params.waitMs > 0 ? await jobs.waitTerminal(request.jobId, params.waitMs, signal) : submitted };
    }
    if (method === "jobList") {
      assertParamKeys(params, ["limit", "states"], "Job list");
      const allowedStates = new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "unknown"]);
      if (!jobs || !Array.isArray(params.states) || params.states.some((state) => typeof state !== "string" || !allowedStates.has(state)) ||
        new Set(params.states).size !== params.states.length || typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 256) {
        throw new CliError("gateway_bad_request", "Job list params are invalid.");
      }
      return { result: { jobs: jobs.list(params.states as JobState[], params.limit) } };
    }
    if (method === "jobShow") {
      assertParamKeys(params, ["jobId", "waitMs"], "Job show");
      if (!jobs || typeof params.jobId !== "string" || typeof params.waitMs !== "number" ||
        !Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > 25_000) throw new CliError("gateway_bad_request", "Job show params are invalid.");
      return { result: await jobs.wait(params.jobId, params.waitMs, signal) };
    }
    if (method === "jobLogsRead") {
      assertParamKeys(params, ["jobId", "limitBytes", "offset", "waitMs"], "Job logs");
      if (!jobs || typeof params.jobId !== "string" || typeof params.offset !== "number" || typeof params.limitBytes !== "number" || typeof params.waitMs !== "number") {
        throw new CliError("gateway_bad_request", "Job logs params are invalid.");
      }
      return { result: await jobs.logsRead(params.jobId, params.offset, params.limitBytes, params.waitMs, signal) };
    }
    if (method === "jobCancel") {
      assertParamKeys(params, ["cancelOperationId", "jobId"], "Job cancel");
      if (!jobs || typeof params.jobId !== "string" || typeof params.cancelOperationId !== "string") throw new CliError("gateway_bad_request", "Job cancel params are invalid.");
      return { result: await jobs.cancel(params.jobId, params.cancelOperationId) };
    }
    if (method === "eventRead") {
      assertParamKeys(params, ["channels", "cursor", "includeMemoryContent", "limit", "sources", "waitMs"], "Event read");
      const allowedSources = new Set<EventSource>(["gateway", "job", "daemon"]);
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
    if (method === "desktopStatus") {
      assertParamKeys(params, [], "Desktop status");
      return { result: await desktop.status() };
    }
    if (method === "desktopKeepAdd") {
      assertParamKeys(params, ["agentId"], "Desktop keep add");
      if (typeof params.agentId !== "string") throw new CliError("gateway_bad_request", "Desktop keep add params are invalid.");
      return { result: await desktop.keepAdd(params.agentId) };
    }
    if (method === "desktopKeepRemove") {
      assertParamKeys(params, ["agentId", "yes"], "Desktop keep remove");
      if (typeof params.agentId !== "string" || params.yes !== true) {
        throw new CliError("gateway_bad_request", "Desktop keep remove params are invalid.");
      }
      return { result: await desktop.keepRemove(params.agentId, true) };
    }
    if (method === "desktopPrunePlan") {
      assertParamKeys(params, [], "Desktop prune plan");
      return { result: await desktop.prune(false) };
    }
    if (method === "desktopPrune") {
      assertParamKeys(params, ["yes"], "Desktop prune");
      if (params.yes !== true) throw new CliError("gateway_bad_request", "Desktop prune params are invalid.");
      return { result: await desktop.prune(true) };
    }
    if (method === "desktopPruneEnable") {
      assertParamKeys(params, [], "Desktop prune enable");
      return { result: await desktop.setEnabled(true) };
    }
    if (method === "desktopPruneDisable") {
      assertParamKeys(params, [], "Desktop prune disable");
      return { result: await desktop.setEnabled(false) };
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

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  let networkPort: number | null = null;
  let ownsSocket = false;
  try {
    await listenUnix(localServer, socketPath);
    ownsSocket = true;
    await chmod(socketPath, 0o600);
    if (networkServer && networkConfig) networkPort = await listenNetwork(networkServer, networkConfig);
  } catch (error) {
    await Promise.allSettled([
      closeServer(localServer),
      ...(networkServer ? [closeServer(networkServer)] : []),
      ...(ownsSocket ? [rm(socketPath, { force: true })] : []),
    ]);
    throw error;
  }

  return {
    socketPath,
    network: networkPort === null ? null : { host: "127.0.0.1", port: networkPort },
    handshake,
    close: async () => {
      await events.close();
      const results = await Promise.allSettled([
        closeServer(localServer),
        ...(networkServer ? [closeServer(networkServer)] : []),
        jobs?.close() ?? Promise.resolve(),
        desktop.close(),
        filesystem.close(),
      ]);
      await rm(socketPath, { force: true });
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    },
  };
}
