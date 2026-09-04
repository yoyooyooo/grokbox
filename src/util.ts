import { usage } from "./errors.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseInteger(
  raw: unknown,
  spec: { name: string; min: number; max: number; defaultValue?: number },
): number {
  if (raw === undefined || raw === null || raw === "") {
    if (spec.defaultValue !== undefined) return spec.defaultValue;
    throw usage(`${spec.name} is required.`);
  }
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    throw usage(`${spec.name} must be an integer between ${spec.min} and ${spec.max}.`);
  }
  return n;
}

export function emptyToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length === 0 ? null : value;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuidV4(value: string, name: string): string {
  if (!UUID_V4.test(value)) throw usage(`${name} must be a UUID v4.`);
  return value;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function containsSensitiveLeak(haystack: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && haystack.includes(secret));
}
