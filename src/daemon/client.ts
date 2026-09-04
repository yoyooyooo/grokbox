import { request } from "node:http";
import type { FetchFn } from "../deps.ts";
import { CliError, EXIT_CODES, type ErrorCode } from "../errors.ts";
import { isRecord } from "../util.ts";
import {
  DAEMON_PROTOCOL_MAJOR,
  type DaemonHandshake,
  type DaemonMethod,
  type DaemonResponse,
} from "./protocol.ts";

const DAEMON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILESYSTEM_OPERATIONS = new Set(["stat", "list", "read", "download", "write", "mkdir", "upload", "remove", "remove-recursive", "exec"]);

const MANAGEMENT_WRITES = new Set<DaemonMethod>([
  "createAgent",
  "createGroup",
  "updateAgent",
  "setGroupMembers",
  "setAgentNotifyOnUpdates",
  "setAgentHiddenFromSidebar",
  "deleteAgent",
  "fsWrite",
  "fsMkdir",
  "fsUploadCommit",
  "fsRemove",
  "jobSubmit",
  "jobCancel",
  "desktopKeepAdd",
  "desktopKeepRemove",
  "desktopPrune",
  "desktopPruneEnable",
  "desktopPruneDisable",
]);

type DaemonCallResult = { result: unknown; gateway?: { pid: number; startedAt: number } };

export type DaemonCallOptions = { ignoreSignal?: boolean };

export interface DaemonClient {
  handshake(): Promise<DaemonHandshake>;
  call(
    method: DaemonMethod,
    params: Record<string, unknown>,
    options?: DaemonCallOptions,
  ): Promise<DaemonCallResult>;
}

function lostResponse(method: DaemonMethod): CliError {
  if (method === "sendPrompt") {
    return new CliError("send_delivery_unknown", "Send may have reached the daemon before the response was lost.");
  }
  if (MANAGEMENT_WRITES.has(method)) {
    return new CliError("operation_outcome_unknown", "The write may have reached the daemon before the response was lost.");
  }
  return new CliError("daemon_unreachable", "Daemon is unreachable.", { retryable: true });
}

function parseResponse(text: string, status: number): DaemonCallResult {
  if (status === 401 || status === 403) {
    throw new CliError("daemon_unauthorized", "Daemon rejected the shared credential.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("daemon_unreachable", "Daemon returned invalid JSON.");
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    throw new CliError("daemon_unreachable", "Daemon returned an invalid response envelope.");
  }
  const response = parsed as DaemonResponse;
  if (!response.ok) {
    const error = (parsed as Record<string, unknown>).error;
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["error", "ok"]) ||
      !isRecord(error) || JSON.stringify(Object.keys(error).sort()) !== JSON.stringify(["code", "message", "retryable"]) ||
      typeof error.code !== "string" || error.code === "ok" || !(error.code in EXIT_CODES) ||
      typeof error.message !== "string" || typeof error.retryable !== "boolean") {
      throw new CliError("daemon_unreachable", "Daemon returned an invalid failure envelope.");
    }
    throw new CliError(error.code as ErrorCode, error.message, { retryable: error.retryable });
  }
  const successKeys = Object.keys(parsed).sort();
  const expectedSuccessKeys = response.gateway === undefined ? ["ok", "result"] : ["gateway", "ok", "result"];
  if (JSON.stringify(successKeys) !== JSON.stringify(expectedSuccessKeys)) {
    throw new CliError("daemon_unreachable", "Daemon returned an invalid success envelope.");
  }
  if (response.gateway !== undefined && (!isRecord(response.gateway) ||
    JSON.stringify(Object.keys(response.gateway).sort()) !== JSON.stringify(["pid", "startedAt"]) ||
    typeof response.gateway.pid !== "number" || !Number.isSafeInteger(response.gateway.pid) ||
    typeof response.gateway.startedAt !== "number" || !Number.isSafeInteger(response.gateway.startedAt))) {
    throw new CliError("daemon_unreachable", "Daemon returned invalid Gateway metadata.");
  }
  return { result: response.result, ...(response.gateway ? { gateway: { pid: response.gateway.pid, startedAt: response.gateway.startedAt } } : {}) };
}

async function responseTextBounded(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return "";
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > DAEMON_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new CliError("daemon_unreachable", "Daemon response exceeds the client byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function validateHandshake(value: unknown): DaemonHandshake {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
    "capabilities", "daemonGeneration", "daemonPid", "daemonVersion", "filesystemRoots", "gateway", "protocolMajor", "startedAt",
  ]) || value.protocolMajor !== DAEMON_PROTOCOL_MAJOR || typeof value.daemonVersion !== "string" ||
    typeof value.daemonPid !== "number" || !Number.isSafeInteger(value.daemonPid) || value.daemonPid < 1 ||
    typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
    typeof value.daemonGeneration !== "string" || !UUID_V4.test(value.daemonGeneration) ||
    !Array.isArray(value.capabilities) || value.capabilities.some((capability) => typeof capability !== "string") ||
    new Set(value.capabilities).size !== value.capabilities.length || !Array.isArray(value.filesystemRoots) ||
    !isRecord(value.gateway) || JSON.stringify(Object.keys(value.gateway).sort()) !== JSON.stringify(["pid", "startedAt"]) ||
    typeof value.gateway.pid !== "number" || !Number.isSafeInteger(value.gateway.pid) ||
    typeof value.gateway.startedAt !== "number" || !Number.isSafeInteger(value.gateway.startedAt)) {
    throw new CliError("daemon_protocol_mismatch", "Daemon handshake is invalid or incompatible.");
  }
  for (const root of value.filesystemRoots) {
    if (!isRecord(root) || JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(["name", "operations"]) ||
      typeof root.name !== "string" || !Array.isArray(root.operations) ||
      root.operations.some((operation) => typeof operation !== "string" || !FILESYSTEM_OPERATIONS.has(operation)) ||
      new Set(root.operations).size !== root.operations.length) {
      throw new CliError("daemon_protocol_mismatch", "Daemon handshake filesystem projection is invalid.");
    }
  }
  return value as DaemonHandshake;
}

abstract class VersionedDaemonClient implements DaemonClient {
  async handshake(): Promise<DaemonHandshake> {
    const response = await this.call("handshake", {});
    return validateHandshake(response.result);
  }

  abstract call(
    method: DaemonMethod,
    params: Record<string, unknown>,
    options?: DaemonCallOptions,
  ): Promise<DaemonCallResult>;
}

export class LocalDaemonClient extends VersionedDaemonClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  async call(
    method: DaemonMethod,
    params: Record<string, unknown>,
    options: DaemonCallOptions = {},
  ): Promise<DaemonCallResult> {
    const body = JSON.stringify({ protocolMajor: DAEMON_PROTOCOL_MAJOR, method, params });
    return await new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: "/v1/rpc",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          let text = "";
          let bytes = 0;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > DAEMON_RESPONSE_MAX_BYTES) {
              req.destroy(new Error("response too large"));
              return;
            }
            text += chunk;
          });
          res.on("end", () => {
            cleanup();
            try {
              resolve(parseResponse(text, res.statusCode ?? 0));
            } catch (error) {
              if (error instanceof CliError && error.code !== "daemon_unreachable") reject(error);
              else reject(lostResponse(method));
            }
          });
        },
      );
      const abort = () => req.destroy(new Error("cancelled"));
      const cleanup = () => this.signal?.removeEventListener("abort", abort);
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        cleanup();
        reject(lostResponse(method));
      });
      if (!options.ignoreSignal && this.signal) {
        if (this.signal.aborted) {
          req.destroy(new Error("cancelled"));
          return;
        }
        this.signal.addEventListener("abort", abort, { once: true });
      }
      req.end(body);
    });
  }
}

export class RemoteDaemonClient extends VersionedDaemonClient {
  private readonly rpcUrl: string;

  constructor(
    serverUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchFn,
    private readonly signal?: AbortSignal,
  ) {
    super();
    this.rpcUrl = `${serverUrl.replace(/\/$/, "")}/v1/rpc`;
  }

  async call(
    method: DaemonMethod,
    params: Record<string, unknown>,
    options: DaemonCallOptions = {},
  ): Promise<DaemonCallResult> {
    const body = JSON.stringify({ protocolMajor: DAEMON_PROTOCOL_MAJOR, method, params });
    let response: Response;
    try {
      response = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body,
        signal: !options.ignoreSignal && this.signal
          ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.signal])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw lostResponse(method);
    }
    try {
      return parseResponse(await responseTextBounded(response), response.status);
    } catch (error) {
      if (!(error instanceof CliError) || error.code === "daemon_unreachable") {
        throw lostResponse(method);
      }
      throw error;
    }
  }
}
