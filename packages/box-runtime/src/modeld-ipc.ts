import { createConnection, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { STUB_ECHO_MODEL_ID } from "./models.ts";
import type { StreamPart } from "./session.ts";
import type { AdmissionFailureCode, AdmitRequest, ModelD } from "./modeld.ts";
import { STUB_ECHO_PARTS } from "./modeld-default.ts";

export { STUB_ECHO_MODEL_ID, STUB_ECHO_PARTS };
export const MODELD_MAX_FRAME = 256 * 1024;
/** Submit wait bound; matches default kernel idle TTL. Health/disconnect keep a short timeout. */
export const MODELD_SUBMIT_TIMEOUT_MS = 30_000;
export function modeldSocketPath(runRoot: string): string { return join(runRoot, "modeld.sock"); }
export type StubModeldFailureCode = AdmissionFailureCode | "malformed" | "too-large" | "unknown-method" | "excess-fields" | "down";
const SUBMIT_KEYS = ["method", "serverGeneration", "host", "invocationId", "turnId", "agentId", "envelope"];
const DISCONNECT_KEYS = ["method", "serverGeneration", "host", "invocationId"];
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value); return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}
export function encodeModeldFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MODELD_MAX_FRAME) throw new Error("modeld frame too large");
  const header = Buffer.alloc(4); header.writeUInt32BE(json.length); return Buffer.concat([header, json]);
}
export function decodeModeldFrame(buffer: Buffer): { value: unknown; rest: Buffer } | { error: StubModeldFailureCode } | null {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32BE(0);
  if (length > MODELD_MAX_FRAME) return { error: "too-large" };
  if (buffer.length < 4 + length) return null;
  const payload = buffer.subarray(4, 4 + length);
  try {
    const text = payload.toString("utf8");
    if (!Buffer.from(text).equals(payload)) return { error: "malformed" };
    return { value: JSON.parse(text) as unknown, rest: Buffer.from(buffer.subarray(4 + length)) };
  } catch { return { error: "malformed" }; }
}
const fail = (code: StubModeldFailureCode) => ({ ok: false as const, code, userVisible: true });
async function handleRequest(kernel: ModelD, raw: unknown, signal: AbortSignal): Promise<unknown> {
  if (!isRecord(raw)) return fail("malformed");
  if (raw.method === "health") {
    if (!exactKeys(raw, ["method"])) return fail("excess-fields");
    // Readiness is service liveness, NOT committed Host admission (which would create a signing cycle).
    return { ok: true, method: "health", version: 2, serverGeneration: kernel.serverGeneration };
  }
  if (raw.method === "disconnect") {
    if (!exactKeys(raw, DISCONNECT_KEYS)) return fail("excess-fields");
    return { ...kernel.disconnect(raw as unknown as Pick<AdmitRequest, "serverGeneration" | "host" | "invocationId">), method: "disconnect" };
  }
  if (raw.method !== "submit") return fail("unknown-method");
  if (!exactKeys(raw, SUBMIT_KEYS)) return fail("excess-fields");
  const result = await kernel.admit(raw as unknown as AdmitRequest, signal);
  return result.ok ? { ...result, method: "submit" } : result;
}
function writeFrame(socket: Socket, value: unknown): void {
  try { socket.end(encodeModeldFrame(value)); }
  catch { socket.end(encodeModeldFrame(fail("too-large"))); }
}
export function attachClient(socket: Socket, kernel: ModelD): void {
  let buf: Buffer = Buffer.alloc(0);
  let received = false;
  let finished = false;
  const controller = new AbortController();
  const disconnect = () => { if (!finished) controller.abort(); };
  socket.on("error", disconnect); socket.on("end", disconnect); socket.on("close", disconnect);
  socket.setTimeout(1000, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (received || buf.length + chunk.length > MODELD_MAX_FRAME + 4) { controller.abort(); writeFrame(socket, fail("too-large")); return; }
    buf = Buffer.concat([buf, chunk]);
    const decoded = decodeModeldFrame(buf);
    if (decoded == null) return;
    received = true; buf = Buffer.alloc(0);
    if ("error" in decoded) { finished = true; writeFrame(socket, fail(decoded.error)); return; }
    if (decoded.rest.length > 0) { finished = true; writeFrame(socket, fail("malformed")); return; }
    socket.setTimeout(0);
    void handleRequest(kernel, decoded.value, controller.signal).then((result) => {
      finished = true; if (!socket.destroyed) writeFrame(socket, result);
    }, () => { finished = true; if (!socket.destroyed) writeFrame(socket, fail("malformed")); });
  });
}
export function isAddrInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EADDRINUSE" || error.code === "EEXIST"));
}
export async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ path: socketPath, exclusive: true }, () => { server.off("error", onError); resolve(); });
  });
}
export async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
/** A connectable socket is owned even if it is old-protocol, saturated or not answering health. */
export async function socketInUse(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ path });
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(true), 80); // uncertainty never authorizes unlink
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ENOENT" && error.code !== "ECONNREFUSED"));
  });
}
export type StubModeldServer = {
  socketPath: string; serverGeneration: string; dispatches: () => number;
  admissionStats: ModelD["stats"]; stop: () => Promise<void>; wait: () => Promise<void>;
};
/** Unix listen/sweep/stop live in `modeld-serve.ts` (Effect). This file stays Host/preload-safe. */
export async function callStubModeld(runRoot: string, request: unknown, timeoutMs = 1000, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error("modeld cancelled");
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    let buf: Buffer = Buffer.alloc(0); let settled = false;
    const timer = setTimeout(() => finish(new Error("modeld timeout")), timeoutMs);
    const abort = () => finish(new Error("modeld cancelled"));
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => { try { socket.write(encodeModeldFrame(request)); } catch { finish(new Error("modeld write failed")); } });
    socket.on("data", (chunk: Buffer) => {
      if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) { finish(undefined, fail("too-large")); return; }
      buf = Buffer.concat([buf, chunk]); const decoded = decodeModeldFrame(buf);
      if (decoded == null) return;
      if ("error" in decoded) { finish(undefined, fail(decoded.error)); return; }
      finish(undefined, decoded.value);
    });
    socket.on("error", () => finish(new Error("modeld down")));
    socket.on("end", () => finish(new Error("modeld disconnected")));
    socket.on("close", () => finish(new Error("modeld disconnected")));
    if (signal?.aborted) abort();
  });
}
export async function modeldHandshake(runRoot: string, signal?: AbortSignal): Promise<string> {
  const response = await callStubModeld(runRoot, { method: "health" }, 1000, signal);
  if (!isRecord(response) || response.ok !== true || response.method !== "health" || response.version !== 2 ||
    typeof response.serverGeneration !== "string" || !/^[a-f0-9-]{36}$/.test(response.serverGeneration)) throw new Error("modeld handshake failed");
  return response.serverGeneration;
}
export async function probeStubModeld(runRoot: string, timeoutMs = 80): Promise<boolean> {
  try { const response = await callStubModeld(runRoot, { method: "health" }, timeoutMs);
    return isRecord(response) && response.ok === true && response.method === "health" && response.version === 2 &&
      typeof response.serverGeneration === "string" && /^[a-f0-9-]{36}$/.test(response.serverGeneration);
  } catch { return false; }
}
export function isModeldFailure(value: unknown): value is { ok: false; code: StubModeldFailureCode } {
  return isRecord(value) && value.ok === false && typeof value.code === "string";
}
export function submitPartsFromResponse(value: unknown): { parts: StreamPart[]; dispatched: boolean; assignment: "main" | "agent"; modelId: string } {
  if (!isRecord(value) || value.ok !== true || value.method !== "submit") throw new Error("modeld submit failed");
  if (typeof value.modelId !== "string" || value.modelId.length === 0 || !Array.isArray(value.parts) || (value.assignment !== "main" && value.assignment !== "agent")) throw new Error("modeld malformed output");
  return { parts: value.parts as StreamPart[], dispatched: value.dispatched === true, assignment: value.assignment, modelId: value.modelId };
}
