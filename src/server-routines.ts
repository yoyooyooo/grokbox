import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { projectNativeRoutines, type RoutineView } from "./routines.ts";
import { CliError } from "./errors.ts";
import { isRecord } from "./util.ts";

// Internal cloud Routine adapter. Only the selected Profile's explicit credential
// is used; Gateway authority and desktop state are never fallback identities.

const SERVER_ROUTINE_PATHS = {
  listAgents: "/aiserver.v1.GrokBotService/ListGrokBotAgents",
  listAutomations: "/aiserver.v1.GrokBotService/ListGrokBotAgentAutomations",
  mintWebhookKey: "/aiserver.v1.DashboardService/CreateAutomationWebhookApiKey",
} as const;

export const DEFAULT_SERVER_BACKEND_URL = "https://api2.cursor.sh";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_KEY_BYTES = 4096;
const MAX_AGENTS = 5000;
const MAX_ROUTINES = 100;
const NIL_AUTOMATION_ID = "00000000-0000-5000-8000-000000000000";

export type ServerAgent = {
  id: string;
  name: string;
  harness: "box" | "temporal" | null;
  isGroup: boolean;
};

export type ServerRoutine = RoutineView & {
  serverId: string;
  webhookUrl: string | null;
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
// Bounded protobuf adapter for the selected internal Server methods.
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

function readVarint(buffer: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = buffer[offset + index];
    if (byte === undefined) throw protocolFailure("truncated_varint");
    if (index === 9 && byte > 1) throw protocolFailure("varint_overflow");
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  throw protocolFailure("varint_overflow");
}

type ProtoField = { number: number; wire: number; value: Buffer | bigint };

function decodeFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.next;
    if (key.value < 8n || key.value > 0xffffffffn) throw protocolFailure("invalid_tag");
    const number = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.next;
      fields.push({ number, wire, value: value.value });
    } else if (wire === 2) {
      const size = readVarint(buffer, offset);
      offset = size.next;
      if (size.value > BigInt(buffer.length - offset)) throw protocolFailure("truncated_field");
      const length = Number(size.value);
      fields.push({ number, wire, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw protocolFailure("truncated_field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw protocolFailure("truncated_field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else {
      if (wire === 3) {
        offset = skipGroup(buffer, offset, number, 0);
        fields.push({ number, wire, value: 0n });
        continue;
      }
      throw protocolFailure("unsupported_wire_type");
    }
  }
  return fields;
}

function skipGroup(buffer: Buffer, start: number, expected: number, depth: number): number {
  if (depth > 32) throw protocolFailure("group_depth_exceeded");
  let offset = start;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    if (tag.value < 8n || tag.value > 0xffffffffn) throw protocolFailure("invalid_tag");
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    offset = tag.next;
    if (wire === 4) {
      if (number !== expected) throw protocolFailure("group_mismatch");
      return offset;
    }
    if (wire === 3) offset = skipGroup(buffer, offset, number, depth + 1);
    else if (wire === 0) offset = readVarint(buffer, offset).next;
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const size = readVarint(buffer, offset);
      if (size.value > BigInt(buffer.length - size.next)) throw protocolFailure("truncated_field");
      offset = size.next + Number(size.value);
    } else throw protocolFailure("unsupported_wire_type");
    if (offset > buffer.length) throw protocolFailure("truncated_field");
  }
  throw protocolFailure("truncated_group");
}

function firstBytes(fields: ProtoField[], number: number): Buffer | undefined {
  const hits = fields.filter((field) => field.number === number);
  if (hits.length > 1 || (hits.length === 1 && hits[0]!.wire !== 2)) {
    throw protocolFailure("invalid_required_field");
  }
  const value = hits[0]?.value;
  return value instanceof Buffer ? value : undefined;
}

function text(buffer: Buffer | undefined): string {
  try {
    return buffer === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw protocolFailure("invalid_utf8");
  }
}

export function webhookUrlFor(backendUrl: string, serverId: string): string {
  return new URL(`/automations/webhook/${encodeURIComponent(serverId)}`, normalizedBackend(backendUrl))
    .toString();
}

export function normalizedBackend(backendUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new CliError("profile_invalid", "Server backend URL is invalid.");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username || parsed.password || backendUrl.includes("?") || backendUrl.includes("#") || parsed.pathname !== "/") {
    throw new CliError("profile_invalid", "Server backend must be an HTTPS origin (HTTP only on loopback), without credentials, query, or fragment.");
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type ServerCallDeps = {
  fetch: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
  // Internal file-open seam for deterministic cancellation coverage.
  openWebhookKeyStore?: typeof open;
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
    if (controller.signal.aborted) throw new Error("aborted");
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
    if (controller.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw protocolFailure("request_cancelled");
    }
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
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/proto") {
      await response.body?.cancel().catch(() => undefined);
      throw protocolFailure("response_content_type_invalid");
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
  const seen = new Set<string>();
  const fields = decodeFields(body);
  const truncated = fields.filter((field) => field.number === 3);
  if (truncated.length > 1 || (truncated[0] && truncated[0].wire !== 0)) throw protocolFailure("agent_truncation_invalid");
  if (truncated[0] && truncated[0].value !== 0n) throw protocolFailure("agent_roster_truncated");
  for (const field of fields) {
    if (field.number !== 1) continue;
    if (!(field.value instanceof Buffer) || field.wire !== 2) throw protocolFailure("agent_envelope_invalid");
    const inner = decodeFields(field.value);
    const id = text(firstBytes(inner, 12));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || seen.has(id)) {
      throw protocolFailure("agent_id_invalid");
    }
    seen.add(id);
    // GrokBotAgent.kind field 19: UNSPECIFIED=0, AGENT=1, ROOM=2.
    const kinds = inner.filter((field) => field.number === 19);
    if (kinds.length > 1 || (kinds[0] && kinds[0].wire !== 0)) throw protocolFailure("agent_kind_invalid");
    const kind = kinds[0]?.value ?? 0n;
    if (kind !== 0n && kind !== 1n && kind !== 2n) throw protocolFailure("agent_kind_unknown");
    const harness = text(firstBytes(inner, 13));
    const name = text(firstBytes(inner, 3));
    if (name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw protocolFailure("agent_name_invalid");
    agents.push({
      id,
      name,
      harness: harness === "temporal" || harness === "box" ? harness : null,
      isGroup: kind === 2n,
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
  const records: Record<string, unknown>[] = [];
  const serverIds: string[] = [];
  const seen = new Set<string>();
  for (const field of decodeFields(body)) {
    if (field.number !== 1) continue;
    if (!(field.value instanceof Buffer) || field.wire !== 2) throw protocolFailure("routine_envelope_invalid");
    const inner = decodeFields(field.value);
    const serverId = text(firstBytes(inner, 1));
    const recordBytes = firstBytes(inner, 2);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(serverId) || seen.has(serverId)) {
      throw protocolFailure("server_id_invalid");
    }
    if (recordBytes === undefined) throw protocolFailure("record_missing");
    if (recordBytes.length > MAX_RECORD_BYTES) throw protocolFailure("record_oversized");
    const json = text(recordBytes);
    let record: unknown;
    try {
      record = JSON.parse(json);
    } catch {
      throw protocolFailure("record_not_json");
    }
    if (!isRecord(record)) throw protocolFailure("record_not_object");
    seen.add(serverId);
    records.push(record);
    serverIds.push(serverId);
    if (records.length > MAX_ROUTINES) throw protocolFailure("too_many_routines");
  }
  try {
    return projectNativeRoutines(options.agentId, records).catalog.routines.map((routine, index) => ({
      ...routine,
      mutable: false,
      serverId: serverIds[index]!,
      webhookUrl: routine.trigger.type === "webhook" ? webhookUrlFor(options.backendUrl, serverIds[index]!) : null,
    }));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw protocolFailure("routine_record_invalid");
  }
}

// ---------------------------------------------------------------------------
// Webhook credential
// ---------------------------------------------------------------------------

function assertWebhookKey(value: string): string {
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES || /[\x00-\x20\x7f]/.test(value)) {
    throw protocolFailure("key_invalid");
  }
  return value;
}

async function mintWebhookKey(
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

// Never address the selected Routine. Only this fixed, different nonexistent ID is safe.
export async function probeWebhookKey(
  deps: ServerCallDeps,
  options: { backendUrl: string; key: string; timeoutMs: number; serverId: string },
): Promise<boolean> {
  if (options.serverId === NIL_AUTOMATION_ID) throw protocolFailure("unsafe_probe_target");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs);
  try {
    if (controller.signal.aborted) throw protocolFailure("request_cancelled");
    const response = await deps.fetch(webhookUrlFor(options.backendUrl, NIL_AUTOMATION_ID), {
      method: "POST",
      headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    const detail: unknown = JSON.parse(text(await readBounded(response, 64 * 1024)));
    if (controller.signal.aborted) throw protocolFailure("request_cancelled");
    if (!response.redirected && response.status === 401 && isRecord(detail) && detail.code === "error") {
      if (detail.message === `User API key missing required scope: automation:${NIL_AUTOMATION_ID}`) return true;
      if (detail.message === "Invalid API key") return false;
    }
    throw protocolFailure("verification_unknown");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw protocolFailure(controller.signal.aborted ? "request_cancelled" : "verification_unknown");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

/** Credential fingerprints conservatively isolate principals, including rotation. */
export async function cachedWebhookKey(
  deps: ServerCallDeps,
  options: { backendUrl: string; token: string; timeoutMs: number; configDir: string; agentId: string; routine: ServerRoutine },
): Promise<string> {
  if (options.routine.createdAtMs === null) throw protocolFailure("routine_incarnation_missing");
  const scope = createHash("sha256").update(JSON.stringify([
    normalizedBackend(options.backendUrl),
    createHash("sha256").update(options.token).digest("hex"),
    options.agentId, options.routine.serverId, options.routine.createdAtMs,
  ])).digest("hex");
  const directory = join(options.configDir, "server-webhook-keys");
  const path = join(directory, `${scope}.json`);
  const lockPath = join(directory, `${scope}.lock`);
  let lock: FileHandle | undefined;
  let temporary: string | undefined;
  let preserveLock = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 ||
        (process.getuid && dir.uid !== process.getuid())) throw protocolFailure("key_store_permissions");
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let cached: FileHandle | undefined;
    try {
      cached = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    if (cached) {
      try {
        const stat = await cached.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 8192 ||
            (process.getuid && stat.uid !== process.getuid())) throw protocolFailure("key_store_permissions");
        const bytes = Buffer.alloc(8193);
        const { bytesRead } = await cached.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 8192) throw protocolFailure("key_store_corrupt");
        const record: unknown = JSON.parse(text(bytes.subarray(0, bytesRead)));
        if (!isRecord(record) || record.version !== 1 || record.scope !== scope || typeof record.key !== "string" ||
            Object.keys(record).length !== 3) throw protocolFailure("key_store_corrupt");
        return assertWebhookKey(record.key);
      } finally {
        await cached.close();
      }
    }
    if (deps.signal?.aborted) throw protocolFailure("request_cancelled");
    // Establish a writable protected destination before any mint side effect.
    temporary = join(directory, `${scope}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const output = await (deps.openWebhookKeyStore ?? open)(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      if (deps.signal?.aborted) throw protocolFailure("request_cancelled");
      // An interrupted/uncertain mint must not be repeated on the next command.
      preserveLock = true;
      const key = await mintWebhookKey(deps, { ...options, serverId: options.routine.serverId });
      await output.writeFile(JSON.stringify({ version: 1, scope, key }), "utf8");
      await output.sync();
      await output.close();
      await rename(temporary, path);
      temporary = undefined;
      preserveLock = false;
      return key;
    } finally {
      await output.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CliError && (error.code === "credential_invalid" || error.code === "target_not_found" ||
        (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408))) {
      preserveLock = false;
    }
    if (preserveLock) {
      throw new CliError("operation_outcome_unknown", "Webhook key mint outcome is unknown; no automatic retry is safe. Inspect the protected store lock before another attempt.", {
        failureCode: "mint_outcome_unknown", retryable: false,
      });
    }
    if (error instanceof CliError) throw error;
    throw protocolFailure("key_store_unavailable");
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    if (lock) {
      await lock.close();
      if (!preserveLock) await unlink(lockPath).catch(() => undefined);
    }
  }
}
