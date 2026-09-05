import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { STUB_ECHO_MODEL_ID } from "./models.ts";
import type { StreamPart } from "./session.ts";

export { STUB_ECHO_MODEL_ID };

export const MODELD_MAX_FRAME = 16 * 1024;

export const STUB_ECHO_PARTS: StreamPart[] = [
  { type: "text-delta", textDelta: "echo" },
  { type: "finish", reason: "stop" },
];

export function modeldSocketPath(runRoot: string): string {
  return join(runRoot, "modeld.sock");
}

export type StubModeldFailureCode =
  | "malformed"
  | "too-large"
  | "unknown-method"
  | "excess-fields"
  | "wrong-model"
  | "missing-ids"
  | "conflict"
  | "disconnected"
  | "down";

type InvocationRow = {
  agentId: string;
  modelId: string;
  parts: StreamPart[];
  dispatched: boolean;
  disconnected: boolean;
};

const HEALTH_KEYS = ["method"] as const;
const SUBMIT_KEYS = ["method", "invocationId", "agentId", "modelId"] as const;
const DISCONNECT_KEYS = ["method", "invocationId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;
  return allowed.every((key) => keys.includes(key));
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 128) return null;
  if (/[\n\r]/.test(value)) return null;
  return value;
}

export function encodeModeldFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MODELD_MAX_FRAME) {
    throw new Error("modeld frame too large");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

export function decodeModeldFrame(buffer: Buffer): { value: unknown; rest: Buffer } | { error: StubModeldFailureCode } | null {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32BE(0);
  if (length > MODELD_MAX_FRAME) return { error: "too-large" };
  if (buffer.length < 4 + length) return null;
  const payload = buffer.subarray(4, 4 + length);
  try {
    return { value: JSON.parse(payload.toString("utf8")) as unknown, rest: Buffer.from(buffer.subarray(4 + length)) };
  } catch {
    return { error: "malformed" };
  }
}

function fail(code: StubModeldFailureCode): { ok: false; code: StubModeldFailureCode } {
  return { ok: false, code };
}

function handleRequest(
  registry: Map<string, InvocationRow>,
  stats: { dispatches: number },
  raw: unknown,
): unknown {
  if (!isRecord(raw)) return fail("malformed");
  const method = raw.method;
  if (method === "health") {
    if (!exactKeys(raw, HEALTH_KEYS)) return fail("excess-fields");
    return { ok: true, method: "health" };
  }
  if (method === "disconnect") {
    if (!exactKeys(raw, DISCONNECT_KEYS)) return fail("excess-fields");
    const invocationId = boundedId(raw.invocationId);
    if (invocationId == null) return fail("missing-ids");
    const existing = registry.get(invocationId);
    if (existing) existing.disconnected = true;
    else registry.set(invocationId, { agentId: "", modelId: STUB_ECHO_MODEL_ID, parts: [], dispatched: false, disconnected: true });
    return { ok: true, method: "disconnect" };
  }
  if (method !== "submit") return fail("unknown-method");
  if (!exactKeys(raw, SUBMIT_KEYS)) return fail("excess-fields");
  const invocationId = boundedId(raw.invocationId);
  const agentId = boundedId(raw.agentId);
  const modelId = boundedId(raw.modelId);
  if (invocationId == null || agentId == null || modelId == null) return fail("missing-ids");
  if (modelId !== STUB_ECHO_MODEL_ID) return fail("wrong-model");
  const existing = registry.get(invocationId);
  if (existing) {
    if (existing.disconnected) return fail("disconnected");
    if (existing.agentId !== agentId || existing.modelId !== modelId) return fail("conflict");
    return {
      ok: true,
      method: "submit",
      dispatched: false,
      modelId: STUB_ECHO_MODEL_ID,
      parts: existing.parts,
    };
  }
  const parts = STUB_ECHO_PARTS.map((part) => ({ ...part }));
  registry.set(invocationId, {
    agentId,
    modelId,
    parts,
    dispatched: true,
    disconnected: false,
  });
  stats.dispatches += 1;
  return {
    ok: true,
    method: "submit",
    dispatched: true,
    modelId: STUB_ECHO_MODEL_ID,
    parts,
  };
}

function writeFrame(socket: Socket, value: unknown): void {
  try {
    socket.write(encodeModeldFrame(value));
  } catch {
    socket.write(encodeModeldFrame(fail("too-large")));
  }
}

function attachClient(socket: Socket, registry: Map<string, InvocationRow>, stats: { dispatches: number }): void {
  let buf: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const decoded = decodeModeldFrame(buf);
      if (decoded == null) return;
      if ("error" in decoded) {
        writeFrame(socket, fail(decoded.error));
        socket.end();
        return;
      }
      writeFrame(socket, handleRequest(registry, stats, decoded.value));
      buf = Buffer.from(decoded.rest);
    }
  });
}

export type StubModeldServer = {
  socketPath: string;
  dispatches: () => number;
  stop: () => Promise<void>;
  wait: () => Promise<void>;
};

export async function startStubModeldServer(input: { runRoot: string; signal?: AbortSignal }): Promise<StubModeldServer> {
  const socketPath = modeldSocketPath(input.runRoot);
  await mkdir(input.runRoot, { recursive: true, mode: 0o700 });
  await chmod(input.runRoot, 0o700).catch(() => undefined);
  await unlink(socketPath).catch(() => undefined);

  const registry = new Map<string, InvocationRow>();
  const stats = { dispatches: 0 };
  const server: Server = createServer((socket) => attachClient(socket, registry, stats));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, exclusive: true }, () => resolve());
  });
  await chmod(socketPath, 0o600).catch(() => undefined);

  let closed = false;
  const stopped = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  };

  const onAbort = () => {
    void stop();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) await stop();

  return {
    socketPath,
    dispatches: () => stats.dispatches,
    stop,
    wait: async () => {
      await stopped;
      input.signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function callStubModeld(runRoot: string, request: unknown, timeoutMs = 1000): Promise<unknown> {
  const socketPath = modeldSocketPath(runRoot);
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("modeld timeout")), timeoutMs);

    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.on("connect", () => {
      try {
        socket.write(encodeModeldFrame(request));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("modeld write failed"));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeModeldFrame(buf);
      if (decoded == null) return;
      if ("error" in decoded) {
        finish(undefined, fail(decoded.error));
        return;
      }
      finish(undefined, decoded.value);
    });
    socket.on("error", (error) => {
      const wrapped = new Error("modeld down");
      wrapped.cause = error;
      finish(wrapped);
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("modeld disconnected"));
    });
  });
}

export async function probeStubModeld(runRoot: string, timeoutMs = 80): Promise<boolean> {
  try {
    const response = await callStubModeld(runRoot, { method: "health" }, timeoutMs);
    return isRecord(response) && response.ok === true && response.method === "health";
  } catch {
    return false;
  }
}

export function isModeldFailure(value: unknown): value is { ok: false; code: StubModeldFailureCode } {
  return isRecord(value) && value.ok === false && typeof value.code === "string";
}

export function submitPartsFromResponse(value: unknown): { parts: StreamPart[]; dispatched: boolean } {
  if (!isRecord(value) || value.ok !== true || value.method !== "submit") {
    throw new Error("modeld submit failed");
  }
  if (value.modelId !== STUB_ECHO_MODEL_ID || !Array.isArray(value.parts)) {
    throw new Error("modeld malformed output");
  }
  return {
    parts: value.parts as StreamPart[],
    dispatched: value.dispatched === true,
  };
}
