import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type ObservationState = "present" | "missing" | "invalid" | "unavailable";
export type Observation<T> = { state: "present"; value: T } | { state: Exclude<ObservationState, "present"> };
export const OBSERVATION_MAX_BYTES = 128 * 1024;

/** Bounded regular-file reads only. Never mkdir, repair, acquire a lock, or disclose file/error content. */
export async function observeText(path: string, maxBytes = OBSERVATION_MAX_BYTES): Promise<Observation<string>> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) return { state: "invalid" };
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) return { state: "invalid" };
    const body = bytes.subarray(0, bytesRead);
    const text = body.toString("utf8");
    if (!Buffer.from(text).equals(body)) return { state: "invalid" };
    return { state: "present", value: text };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") return { state: "invalid" };
    return { state: "unavailable" };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function observeJson<T>(path: string, parse: (value: unknown) => T): Promise<Observation<T>> {
  const read = await observeText(path);
  if (read.state !== "present") return read;
  try { return { state: "present", value: parse(JSON.parse(read.value)) }; }
  catch { return { state: "invalid" }; }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\x00-\x1f]/.test(value);
}

export function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
