export const WIRE_VERSION = 3 as const;

export type WireMethod = "health" | "run-step" | "cancel-step";

export type WireErrorCode =
  | "unsupported_version"
  | "malformed_frame"
  | "unknown_method"
  | "extra_keys"
  | "busy"
  | "capacity"
  | "socket_exists";

export class WireError extends Error {
  readonly code: WireErrorCode;
  constructor(code: WireErrorCode) {
    super(code);
    this.name = "WireError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

export function parseWireVersion(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.version !== "number") return undefined;
  return value.version;
}
