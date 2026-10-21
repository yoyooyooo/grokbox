import { createHash } from "node:crypto";
import { CliError } from "./errors.ts";
import { isRecord } from "./util.ts";

/**
 * Account-level Routine reads and webhook-credential minting, addressed to the Grok Bot
 * Server of record instead of the box Gateway.
 *
 * Why this exists: a Temporal Bot's Routines live on the Server, not in the box's local
 * automation store. The Host bridge that normally proxies them may be absent, in which
 * case the Gateway answers with an empty list and `getAutomationWebhookCredential`
 * refuses. A Profile that declares an explicit Server credential can read the same
 * Server surface directly. It is a separate authority: it never implies Gateway,
 * daemon, Sandbox, or quota access.
 */

export const SERVER_ROUTINE_PATHS = {
  listAgents: "/aiserver.v1.GrokBotService/ListGrokBotAgents",
  listAutomations: "/aiserver.v1.GrokBotService/ListGrokBotAgentAutomations",
  mintWebhookKey: "/aiserver.v1.DashboardService/CreateAutomationWebhookApiKey",
} as const;

export const DEFAULT_SERVER_BACKEND_URL = "https://api2.cursor.sh";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_KEY_BYTES = 4096;
const MAX_AGENTS = 5000;
const MAX_ROUTINES = 1000;
const NIL_AUTOMATION_ID = "00000000-0000-5000-8000-000000000000";

export type ServerAgent = {
  id: string;
  name: string;
  harness: "box" | "temporal" | null;
};

export type ServerRoutine = {
  serverId: string;
  localId: string;
  name: string;
  triggerType: "webhook" | "cron" | "unsupported";
  isEnabled: boolean;
  createdAtMs: number | null;
  webhookUrl: string | null;
};

export type ServerRoutineCredential = {
  serverId: string;
  localId: string;
  url: string;
  key: string;
};

function protocolFailure(failureCode: string): CliError {
  return new CliError(
    "capability_unavailable",
    "The Server Routine surface did not satisfy the supported bounded protocol.",
    { failureCode },
  );
}

function authorizationFailure(failureCode: string): CliError {
  return new CliError(
    "credential_invalid",
    "The configured Server credential was not authorized for Routine access.",
    { failureCode },
  );
}

// ---------------------------------------------------------------------------
// Minimal protobuf: the Server accepts only application/proto for these methods.
// ---------------------------------------------------------------------------

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    if (index >= buffer.length) throw protocolFailure("truncated_varint");
    const byte = buffer[index]!;
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw protocolFailure("varint_overflow");
  }
  return { value, next: index };
}

type ProtoField = { number: number; wire: number; value: Buffer | number };

function decodeFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.next;
    const number = key.value >>> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.next;
      fields.push({ number, wire, value: value.value });
    } else if (wire === 2) {
      const size = readVarint(buffer, offset);
      offset = size.next;
      if (offset + size.value > buffer.length) throw protocolFailure("truncated_field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + size.value) });
      offset += size.value;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw protocolFailure("truncated_field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw protocolFailure("truncated_field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else {
      throw protocolFailure("unsupported_wire_type");
    }
  }
  return fields;
}

function firstBytes(fields: ProtoField[], number: number): Buffer | undefined {
  const hit = fields.find((field) => field.number === number && field.wire === 2);
  return hit?.value instanceof Buffer ? hit.value : undefined;
}

function text(buffer: Buffer | undefined): string {
  return buffer === undefined ? "" : buffer.toString("utf8");
}

// ---------------------------------------------------------------------------
// Server identity of one Routine
// ---------------------------------------------------------------------------

/**
 * The Server's automation id for a box-local Routine: sha256("<agentId>\0<localId>")
 * reshaped into the UUID form the Server stores (index 12 is dropped, index 16 is
 * masked to variant bits). Deterministic, so it can be derived without any credential.
 */
export function stableAutomationId(agentId: string, localId: string): string {
  const hex = createHash("sha256").update(`${agentId}\0${localId}`).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 3) | 8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function webhookUrlFor(backendUrl: string, serverId: string): string {
  return new URL(`/automations/webhook/${encodeURIComponent(serverId)}`, normalizedBackend(backendUrl))
    .toString();
}

export function normalizedBackend(backendUrl: string): string {
  const parsed = new URL(backendUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CliError("profile_invalid", "Server backend URL must use HTTP or HTTPS.");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type ServerCallDeps = {
  fetch: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
};

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) {
      throw protocolFailure("response_oversized");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw protocolFailure("response_oversized");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function call(
  deps: ServerCallDeps,
  backendUrl: string,
  token: string,
  path: string,
  body: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  };
  let response: Response;
  try {
    response = await deps.fetch(new URL(path, normalizedBackend(backendUrl)).toString(), {
      method: "POST",
      headers: {
        accept: "application/proto",
        "content-type": "application/proto",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(body),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    cleanup();
    throw new CliError(
      "gateway_unreachable",
      controller.signal.aborted
        ? "The Server Routine request timed out."
        : "The Server Routine endpoint is unreachable.",
      { failureCode: controller.signal.aborted ? "request_timeout" : "network_failure", retryable: true },
    );
  }
  try {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw protocolFailure("redirect_refused");
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await readBounded(response, MAX_RESPONSE_BYTES)
        .then((buffer) => buffer.toString("utf8"))
        .catch(() => "");
      throw authorizationFailure(authorizationFailureCode(detail));
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError("target_not_found", "The Server does not know that Routine.", {
        failureCode: "routine_not_found",
        httpStatus: 404,
      });
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError("gateway_unreachable", "The Server Routine endpoint refused the request.", {
        failureCode: "provider_refused",
        httpStatus: response.status,
        retryable: true,
      });
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        "capability_unavailable",
        "The Server Routine method is unavailable for this credential.",
        { failureCode: "unexpected_status", httpStatus: response.status },
      );
    }
    return await readBounded(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "gateway_unreachable",
      controller.signal.aborted
        ? "The Server Routine request timed out."
        : "The Server Routine response could not be read.",
      { failureCode: controller.signal.aborted ? "request_timeout" : "response_unreadable", retryable: true },
    );
  } finally {
    cleanup();
  }
}

function authorizationFailureCode(detail: string): string {
  if (/Only the automation owner/i.test(detail)) return "not_routine_owner";
  if (/missing required scope/i.test(detail)) return "scope_mismatch";
  if (/Invalid API key/i.test(detail)) return "invalid_api_key";
  if (/ERROR_NOT_LOGGED_IN|not logged in/i.test(detail)) return "not_signed_in";
  return "credential_refused";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listServerAgents(
  deps: ServerCallDeps,
  options: { backendUrl: string; token: string; timeoutMs: number },
): Promise<ServerAgent[]> {
  const body = await call(deps, options.backendUrl, options.token, SERVER_ROUTINE_PATHS.listAgents, Buffer.alloc(0), options.timeoutMs);
  const agents: ServerAgent[] = [];
  for (const field of decodeFields(body)) {
    if (field.number !== 1 || !(field.value instanceof Buffer)) continue;
    const inner = decodeFields(field.value);
    const id = text(firstBytes(inner, 2));
    if (id.length === 0) continue;
    const harness = text(firstBytes(inner, 13));
    agents.push({
      id,
      name: text(firstBytes(inner, 3)),
      harness: harness === "temporal" || harness === "box" ? harness : null,
    });
    if (agents.length > MAX_AGENTS) throw protocolFailure("too_many_agents");
  }
  return agents;
}

export async function listServerRoutines(
  deps: ServerCallDeps,
  options: { backendUrl: string; token: string; timeoutMs: number; agentId: string },
): Promise<ServerRoutine[]> {
  const body = await call(
    deps,
    options.backendUrl,
    options.token,
    SERVER_ROUTINE_PATHS.listAutomations,
    lengthDelimited(1, Buffer.from(options.agentId, "utf8")),
    options.timeoutMs,
  );
  const routines: ServerRoutine[] = [];
  for (const field of decodeFields(body)) {
    if (field.number !== 1 || !(field.value instanceof Buffer)) continue;
    const inner = decodeFields(field.value);
    const serverId = text(firstBytes(inner, 1));
    const recordBytes = firstBytes(inner, 2);
    if (serverId.length === 0 || recordBytes === undefined) continue;
    if (recordBytes.length > MAX_RECORD_BYTES) throw protocolFailure("record_oversized");
    let record: unknown;
    try {
      record = JSON.parse(recordBytes.toString("utf8"));
    } catch {
      throw protocolFailure("record_not_json");
    }
    if (!isRecord(record)) throw protocolFailure("record_not_object");
    const localId = record.id;
    const name = record.name;
    if (typeof localId !== "string" || localId.length === 0 || localId.length > 256) {
      throw protocolFailure("routine_id_invalid");
    }
    if (typeof name !== "string" || name.length > 512) throw protocolFailure("routine_name_invalid");
    if (typeof record.isEnabled !== "boolean") throw protocolFailure("routine_enabled_invalid");
    const trigger = isRecord(record.trigger) ? record.trigger.type : undefined;
    const triggerType = trigger === "webhook" ? "webhook" : trigger === "cron" ? "cron" : "unsupported";
    const createdAtMs =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt) && record.createdAt > 0
        ? record.createdAt
        : null;
    routines.push({
      serverId,
      localId,
      name,
      triggerType,
      isEnabled: record.isEnabled,
      createdAtMs,
      webhookUrl: triggerType === "webhook" ? webhookUrlFor(options.backendUrl, serverId) : null,
    });
    if (routines.length > MAX_ROUTINES) throw protocolFailure("too_many_routines");
  }
  return routines;
}

// ---------------------------------------------------------------------------
// Webhook credential
// ---------------------------------------------------------------------------

export function assertWebhookKey(value: string): string {
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES || value.includes("\0")) {
    throw protocolFailure("key_invalid");
  }
  return value;
}

export async function mintWebhookKey(
  deps: ServerCallDeps,
  options: { backendUrl: string; token: string; timeoutMs: number; serverId: string },
): Promise<string> {
  const body = await call(
    deps,
    options.backendUrl,
    options.token,
    SERVER_ROUTINE_PATHS.mintWebhookKey,
    lengthDelimited(1, Buffer.from(options.serverId, "utf8")),
    options.timeoutMs,
  );
  const key = text(firstBytes(decodeFields(body), 1));
  if (key.length === 0) throw protocolFailure("key_missing");
  return assertWebhookKey(key);
}

/**
 * Proves a webhook key is live without firing the Routine.
 *
 * Posting to a *different* automation id answers `missing required scope: automation:<id>`
 * for a real key and `Invalid API key` for a dead one. Posting to the Routine's own id
 * would run it, so this probe deliberately never uses it.
 */
export async function probeWebhookKey(
  deps: ServerCallDeps,
  options: { backendUrl: string; token: string; key: string; timeoutMs: number },
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await deps.fetch(new URL(`/automations/webhook/${NIL_AUTOMATION_ID}`, normalizedBackend(options.backendUrl)).toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await readBounded(response, 64 * 1024).then((buffer) => buffer.toString("utf8"));
    return /missing required scope/i.test(text);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
