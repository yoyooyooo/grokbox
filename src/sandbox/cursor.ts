import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { FetchFn } from "../deps.ts";
import { isRecord } from "../util.ts";

export const CURSOR_SANDBOX_BACKEND_URL = "https://api2.cursor.sh";
const GROK_BOT_SERVICE = "aiserver.v1.GrokBotService";
const EXEC_SERVICE_PATH = "/agent.v1.ExecService/Exec";
const MAX_BROKER_RESPONSE_BYTES = 256 * 1024;
const MAX_EXEC_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXEC_FRAME_BYTES = 512 * 1024;

export type SandboxRunState = "absent" | "hibernated" | "running" | "unknown";
export type SandboxFailureKind =
  | "unauthorized"
  | "rate_limited"
  | "provider_refused"
  | "provider_unavailable"
  | "request_timeout"
  | "protocol_invalid"
  | "exec_failed"
  | "exec_outcome_unknown";

export class CursorSandboxError extends Error {
  constructor(
    readonly kind: SandboxFailureKind,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`Cursor Sandbox request failed (${kind}).`);
    this.name = "CursorSandboxError";
  }
}

export class CursorSandboxCancelledError extends Error {
  constructor() {
    super("Cursor Sandbox request was cancelled.");
    this.name = "CursorSandboxCancelledError";
  }
}

export type SandboxStatus = {
  state: SandboxRunState;
  imageUpdateAvailable: boolean | null;
};

export type SandboxTickResult = {
  descriptorRotated: boolean;
};

type SandboxDescriptor = {
  execDaemonUrl: string;
  execDaemonAuthToken: string;
  networkToken: string;
  podId: string;
};

type CursorSandboxClientOptions = {
  accessToken: string;
  fetch: FetchFn;
  timeoutMs: number;
  signal?: AbortSignal;
  machineId?: string;
  randomUUID?: () => string;
  now?: () => number;
};

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const rawMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - nowMs;
  if (!Number.isFinite(rawMs) || rawMs <= 0) return undefined;
  return Math.min(Math.max(Math.round(rawMs), 1000), MAX_RETRY_AFTER_MS);
}

function providerError(status: number, headers: Headers, nowMs: number): CursorSandboxError {
  if (status === 401) return new CursorSandboxError("unauthorized", false);
  if (status === 403) return new CursorSandboxError("provider_refused", false);
  if (status === 429) {
    return new CursorSandboxError("rate_limited", true, parseRetryAfter(headers.get("retry-after"), nowMs));
  }
  if (status === 502 || status === 503 || status === 504) {
    return new CursorSandboxError("provider_unavailable", true);
  }
  return new CursorSandboxError("provider_unavailable", status >= 500);
}

function mapRunState(value: unknown): SandboxRunState {
  if (value === 1 || value === "SAND_BOX_RUN_STATE_ABSENT" || value === "ABSENT") return "absent";
  if (value === 2 || value === "SAND_BOX_RUN_STATE_HIBERNATED" || value === "HIBERNATED") return "hibernated";
  if (value === 3 || value === "SAND_BOX_RUN_STATE_RUNNING" || value === "RUNNING") return "running";
  if (value === 0 || value === "SAND_BOX_RUN_STATE_UNSPECIFIED" || value === "UNSPECIFIED") return "unknown";
  throw new CursorSandboxError("protocol_invalid", false);
}

function descriptorFrom(value: unknown): SandboxDescriptor {
  if (!isRecord(value)) throw new CursorSandboxError("protocol_invalid", false);
  const descriptor = {
    execDaemonUrl: value.execDaemonUrl,
    execDaemonAuthToken: value.execDaemonAuthToken,
    networkToken: value.networkToken,
    podId: value.podId,
  };
  if (Object.values(descriptor).some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new CursorSandboxError("protocol_invalid", false);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(descriptor.execDaemonUrl as string);
  } catch {
    throw new CursorSandboxError("protocol_invalid", false);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new CursorSandboxError("protocol_invalid", false);
  }
  return descriptor as SandboxDescriptor;
}

function enhancedObfuscate(bytes: Uint8Array): Uint8Array {
  let lastByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    const current = bytes[index] ?? 0;
    bytes[index] = ((current ^ lastByte) + index % 256) & 255;
    lastByte = bytes[index] ?? 0;
  }
  return bytes;
}

export function createCursorChecksum(machineId: string, nowMs: number): string {
  const unixKiloSeconds = Math.floor(nowMs / 1_000_000);
  const bytes = new Uint8Array([
    unixKiloSeconds >> 40 & 255,
    unixKiloSeconds >> 32 & 255,
    unixKiloSeconds >> 24 & 255,
    unixKiloSeconds >> 16 & 255,
    unixKiloSeconds >> 8 & 255,
    unixKiloSeconds & 255,
  ]);
  return `${Buffer.from(enhancedObfuscate(bytes)).toString("base64url")}${machineId}`;
}

function encodeEnvelope(value: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(5 + payload.byteLength);
  result[0] = 0;
  result.writeUInt32BE(payload.byteLength, 1);
  payload.copy(result, 5);
  return result;
}

function shellResult(value: unknown): { success: boolean; failure: boolean } {
  if (!isRecord(value)) return { success: false, failure: false };
  const clientMessage = isRecord(value.execClientMessage)
    ? value.execClientMessage
    : isRecord(value.exec_client_message)
      ? value.exec_client_message
      : undefined;
  if (!clientMessage) return { success: false, failure: false };
  const result = isRecord(clientMessage.shellResult)
    ? clientMessage.shellResult
    : isRecord(clientMessage.shell_result)
      ? clientMessage.shell_result
      : undefined;
  if (!result) return { success: false, failure: false };
  return { success: isRecord(result.success), failure: isRecord(result.failure) };
}

function parseExecResponse(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_EXEC_RESPONSE_BYTES) throw new CursorSandboxError("protocol_invalid", false);
  let offset = 0;
  let sawSuccess = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (sawEnd || bytes.byteLength - offset < 5) throw new CursorSandboxError("protocol_invalid", false);
    const flags = bytes[offset] ?? 0;
    if (flags !== 0 && flags !== 0x02 && flags !== 0x80) {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    const length = Buffer.from(bytes.buffer, bytes.byteOffset + offset + 1, 4).readUInt32BE(0);
    offset += 5;
    if (length > MAX_EXEC_FRAME_BYTES || offset + length > bytes.byteLength) {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString("utf8"));
    } catch {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    offset += length;
    if (flags === 0x02 || flags === 0x80) {
      sawEnd = true;
      if (isRecord(value) && value.error !== undefined) {
        const error = value.error;
        const code = isRecord(error) && typeof error.code === "string" ? error.code.toLowerCase() : "";
        if (code === "unauthenticated") throw new CursorSandboxError("unauthorized", false);
        throw new CursorSandboxError("exec_failed", false);
      }
      continue;
    }
    const result = shellResult(value);
    if (result.failure) throw new CursorSandboxError("exec_failed", false);
    if (result.success) sawSuccess = true;
  }
  if (!sawSuccess || !sawEnd) throw new CursorSandboxError("protocol_invalid", false);
}

class ResponseReadAbortedError extends Error {}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new ResponseReadAbortedError());
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      const chunk = item.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new CursorSandboxError("protocol_invalid", false);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class CursorSandboxClient {
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly machineId: string;

  constructor(private readonly options: CursorSandboxClientOptions) {
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.now = options.now ?? Date.now;
    this.machineId = options.machineId ?? this.randomUUID();
  }

  private async fetchBounded(
    url: string,
    init: RequestInit,
    maxBytes: number,
    operation: "broker" | "exec",
  ): Promise<{ response: Response; bytes: Uint8Array }> {
    const controller = new AbortController();
    let callerCancelled = this.options.signal?.aborted === true;
    let timedOut = false;
    const abort = () => {
      callerCancelled = true;
      controller.abort();
    };
    if (callerCancelled) controller.abort();
    else this.options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    try {
      const response = await this.options.fetch(url, { ...init, signal: controller.signal });
      if (callerCancelled) {
        void response.body?.cancel().catch(() => {});
        throw new CursorSandboxCancelledError();
      }
      if (timedOut) {
        void response.body?.cancel().catch(() => {});
        throw operation === "exec"
          ? new CursorSandboxError("exec_outcome_unknown", false)
          : new CursorSandboxError("request_timeout", true);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { response, bytes: new Uint8Array() };
      }
      const bytes = await readBoundedBody(response.body, maxBytes, controller.signal);
      if (callerCancelled) throw new CursorSandboxCancelledError();
      if (timedOut) {
        throw operation === "exec"
          ? new CursorSandboxError("exec_outcome_unknown", false)
          : new CursorSandboxError("request_timeout", true);
      }
      return { response, bytes };
    } catch (error) {
      if (error instanceof CursorSandboxError) throw error;
      if (callerCancelled) throw new CursorSandboxCancelledError();
      if (operation === "exec") throw new CursorSandboxError("exec_outcome_unknown", false);
      if (timedOut) throw new CursorSandboxError("request_timeout", true);
      throw new CursorSandboxError("provider_unavailable", true);
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener("abort", abort);
    }
  }

  private brokerHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.accessToken}`,
      "connect-protocol-version": "1",
      "content-type": "application/json",
      "x-cursor-checksum": createCursorChecksum(this.machineId, this.now()),
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": "0.1.0",
      "x-ghost-mode": "true",
      "x-request-id": this.randomUUID(),
      "x-sand-box-namespace": "prod",
    };
  }

  private async brokerCall(method: "EnsureSandBox" | "GetSandBoxRunState"): Promise<unknown> {
    const { response, bytes } = await this.fetchBounded(
      `${CURSOR_SANDBOX_BACKEND_URL}/${GROK_BOT_SERVICE}/${method}`,
      { method: "POST", headers: this.brokerHeaders(), body: "{}" },
      MAX_BROKER_RESPONSE_BYTES,
      "broker",
    );
    if (!response.ok) throw providerError(response.status, response.headers, this.now());
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new CursorSandboxError("protocol_invalid", false);
    }
  }

  async status(): Promise<SandboxStatus> {
    const value = await this.brokerCall("GetSandBoxRunState");
    if (!isRecord(value)) throw new CursorSandboxError("protocol_invalid", false);
    const imageUpdateAvailable = value.imageUpdateAvailable;
    if (imageUpdateAvailable !== undefined && typeof imageUpdateAvailable !== "boolean") {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    return {
      state: mapRunState(value.state),
      imageUpdateAvailable: imageUpdateAvailable ?? null,
    };
  }

  private async ensure(): Promise<SandboxDescriptor> {
    return descriptorFrom(await this.brokerCall("EnsureSandBox"));
  }

  private async execNoop(descriptor: SandboxDescriptor, execId: string): Promise<void> {
    const endpoint = new URL(EXEC_SERVICE_PATH, descriptor.execDaemonUrl.endsWith("/")
      ? descriptor.execDaemonUrl
      : `${descriptor.execDaemonUrl}/`);
    endpoint.searchParams.set("network_token", descriptor.networkToken);
    const body = {
      id: 1,
      exec_id: execId,
      shell_args: {
        command: ":",
        working_directory: "/workspace",
        timeout: 5000,
        tool_call_id: "grokbox-keeper",
        skip_approval: true,
        simple_commands: [":"],
        has_input_redirect: false,
        has_output_redirect: false,
        parsing_result: {
          parsing_failed: false,
          executable_commands: [{ name: ":", args: [], full_text: ":" }],
          has_redirects: false,
          has_command_substitution: false,
        },
      },
    };
    const { response, bytes } = await this.fetchBounded(endpoint.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.execDaemonAuthToken}`,
        "connect-protocol-version": "1",
        "content-type": "application/connect+json",
      },
      body: encodeEnvelope(body),
    }, MAX_EXEC_RESPONSE_BYTES, "exec");
    if (response.status === 401) throw new CursorSandboxError("unauthorized", false);
    if (!response.ok) throw providerError(response.status, response.headers, this.now());
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/connect+json")) {
      throw new CursorSandboxError("protocol_invalid", false);
    }
    parseExecResponse(bytes);
  }

  async tick(): Promise<SandboxTickResult> {
    const execId = this.randomUUID();
    let descriptor = await this.ensure();
    try {
      await this.execNoop(descriptor, execId);
      return { descriptorRotated: false };
    } catch (error) {
      if (!(error instanceof CursorSandboxError) || error.kind !== "unauthorized") throw error;
    }
    descriptor = await this.ensure();
    try {
      await this.execNoop(descriptor, execId);
      return { descriptorRotated: true };
    } catch (error) {
      if (error instanceof CursorSandboxError && error.kind === "unauthorized") {
        throw new CursorSandboxError("exec_outcome_unknown", false);
      }
      throw error;
    }
  }
}
