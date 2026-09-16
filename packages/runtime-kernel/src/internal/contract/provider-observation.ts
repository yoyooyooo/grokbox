import { sha256Text } from "../../hash.ts";

/** Small, content-free provider facts. These are observations, never permissions
 * to execute, retry, or accept an otherwise incomplete stream. */
export const FINISH_FIELD_SHAPES = ["missing", "null", "empty", "whitespace", "known", "unknown", "invalid_type"] as const;
export const PROVIDER_TERMINALS = ["stop", "tool_calls", "function_call", "length", "content_filter", "insufficient_system_resource", "aborted", "completed", "failed", "incomplete"] as const;
export type FinishFieldShape = typeof FINISH_FIELD_SHAPES[number];
export type ProviderTerminal = typeof PROVIDER_TERMINALS[number];
export type FinishField = { shape: FinishFieldShape; sequence: number; length?: number; digest?: string; reason?: ProviderTerminal };
export type FinishAudit = {
  version: 1;
  fields: Partial<Record<FinishFieldShape, number>>;
  lastField?: FinishField;
  firstUnsupported?: FinishField;
  lastUnsupported?: FinishField;
  firstTerminal?: { reason: ProviderTerminal; sequence: number };
  lastTerminal?: { reason: ProviderTerminal; sequence: number };
  conflict: boolean;
};
export type ToolTerminalAudit = {
  version: 1;
  boundary: "done" | "eof" | "body_error" | "cancelled" | "rejected";
  terminal: "valid" | "missing" | "unsupported" | "conflicting";
  tools: number;
  parseable: number;
  invalidJson: number;
  missingArguments: number;
  mismatched: number;
  residualSse: boolean;
};
export const PROVIDER_REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"] as const;
export type RetryAfterObservation = { state: "absent" | "invalid" | "delay" | "date"; observedAtMs: number; delayMs?: number; atMs?: number };
export type ProviderHttpObservation = {
  status: number;
  requestId?: { header: typeof PROVIDER_REQUEST_ID_HEADERS[number]; value: string };
  retryAfter?: RetryAfterObservation;
};
export type ProviderRouteObservation = { id: string; api: "chat" | "responses" };

export function observationOwn(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
function member<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}
function uint(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

export function observeFinishField(value: unknown, present: boolean, sequence: number): FinishField {
  if (!present) return { shape: "missing", sequence };
  if (value === null) return { shape: "null", sequence };
  if (typeof value !== "string") return { shape: "invalid_type", sequence };
  if (!value.length) return { shape: "empty", sequence, length: 0 };
  if (!value.trim()) return { shape: "whitespace", sequence, length: value.length };
  const reason = member(value, PROVIDER_TERMINALS);
  return reason ? { shape: "known", sequence, reason, length: value.length }
    : { shape: "unknown", sequence, length: value.length, digest: sha256Text(value) };
}
export function addFinishField(prior: FinishAudit | undefined, field: FinishField): FinishAudit {
  const next: FinishAudit = prior ? structuredClone(prior) : { version: 1, fields: {}, conflict: false };
  next.fields[field.shape] = (next.fields[field.shape] ?? 0) + 1;
  next.lastField = { ...field };
  if (field.shape === "unknown" || field.shape === "invalid_type") {
    next.firstUnsupported ??= { ...field }; next.lastUnsupported = { ...field };
  }
  if (field.reason) {
    if (next.firstTerminal && next.firstTerminal.reason !== field.reason) next.conflict = true;
    next.firstTerminal ??= { reason: field.reason, sequence: field.sequence };
    next.lastTerminal = { reason: field.reason, sequence: field.sequence };
  }
  return next;
}
export function finishAuditState(audit: FinishAudit | undefined): ToolTerminalAudit["terminal"] {
  if (audit?.conflict) return "conflicting";
  if ((audit?.fields.unknown ?? 0) || (audit?.fields.invalid_type ?? 0)) return "unsupported";
  return audit?.lastTerminal ? "valid" : "missing";
}
export function projectFinishAudit(value: unknown): FinishAudit | undefined {
  try {
    if (observationOwn(value, "version") !== 1 || typeof observationOwn(value, "conflict") !== "boolean") return undefined;
    const out: FinishAudit = { version: 1, fields: {}, conflict: observationOwn(value, "conflict") as boolean };
    for (const shape of FINISH_FIELD_SHAPES) { const n = observationOwn(observationOwn(value, "fields"), shape); if (uint(n)) out.fields[shape] = n; }
    for (const key of ["lastField", "firstUnsupported", "lastUnsupported"] as const) {
      const raw = observationOwn(value, key), shape = member(observationOwn(raw, "shape"), FINISH_FIELD_SHAPES), sequence = observationOwn(raw, "sequence");
      if (shape && uint(sequence)) {
        const length = observationOwn(raw, "length"), hash = observationOwn(raw, "digest"), reason = member(observationOwn(raw, "reason"), PROVIDER_TERMINALS);
        out[key] = { shape, sequence, ...(uint(length) ? { length } : {}), ...(digest(hash) ? { digest: hash } : {}), ...(reason ? { reason } : {}) };
      }
    }
    for (const key of ["firstTerminal", "lastTerminal"] as const) {
      const raw = observationOwn(value, key), reason = member(observationOwn(raw, "reason"), PROVIDER_TERMINALS), sequence = observationOwn(raw, "sequence");
      if (reason && uint(sequence)) out[key] = { reason, sequence };
    }
    return out;
  } catch { return undefined; }
}
export function projectToolTerminalAudit(value: unknown): ToolTerminalAudit | undefined {
  try {
    if (observationOwn(value, "version") !== 1) return undefined;
    const boundary = member(observationOwn(value, "boundary"), ["done", "eof", "body_error", "cancelled", "rejected"]);
    const terminal = member(observationOwn(value, "terminal"), ["valid", "missing", "unsupported", "conflicting"]);
    const counts: Record<string, number> = {};
    for (const key of ["tools", "parseable", "invalidJson", "missingArguments", "mismatched"]) {
      const n = observationOwn(value, key); if (!uint(n)) return undefined; counts[key] = n;
    }
    const residualSse = observationOwn(value, "residualSse");
    if (!boundary || !terminal || typeof residualSse !== "boolean") return undefined;
    return { version: 1, boundary, terminal, ...counts, residualSse } as ToolTerminalAudit;
  } catch { return undefined; }
}
export function parseRetryAfter(value: string | null, observedAtMs: number): RetryAfterObservation {
  if (value === null) return { state: "absent", observedAtMs };
  if (value.length > 128) return { state: "invalid", observedAtMs };
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const delayMs = Number(text) * 1000;
    return uint(delayMs) ? { state: "delay", observedAtMs, delayMs } : { state: "invalid", observedAtMs };
  }
  // HTTP-date, not locale-dependent free-form dates or fractional seconds.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return { state: "invalid", observedAtMs };
  const atMs = Date.parse(text);
  // Date.parse normalizes impossible calendar dates and ignores a wrong weekday.
  // Such input cannot silently extend a retry lease.
  return uint(atMs) && new Date(atMs).toUTCString() === text
    ? { state: "date", observedAtMs, atMs, delayMs: Math.max(0, atMs - observedAtMs) } : { state: "invalid", observedAtMs };
}
export function projectProviderHttp(value: unknown): ProviderHttpObservation | undefined {
  try {
    const status = observationOwn(value, "status");
    if (!uint(status) || status < 100 || status > 599) return undefined;
    const out: ProviderHttpObservation = { status };
    const raw = observationOwn(value, "requestId"), header = member(observationOwn(raw, "header"), PROVIDER_REQUEST_ID_HEADERS), id = observationOwn(raw, "value");
    if (header && typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)) out.requestId = { header, value: id };
    const retry = observationOwn(value, "retryAfter"), state = member(observationOwn(retry, "state"), ["absent", "invalid", "delay", "date"]), observedAtMs = observationOwn(retry, "observedAtMs");
    const delayMs = observationOwn(retry, "delayMs"), atMs = observationOwn(retry, "atMs");
    if (state && uint(observedAtMs) && ((state === "absent" || state === "invalid") || uint(delayMs))) {
      if (state !== "date" || uint(atMs)) out.retryAfter = { state, observedAtMs, ...(uint(delayMs) ? { delayMs } : {}), ...(uint(atMs) ? { atMs } : {}) };
    }
    return out;
  } catch { return undefined; }
}
export function projectProviderRoute(value: unknown): ProviderRouteObservation | undefined {
  const id = observationOwn(value, "id"), api = member(observationOwn(value, "api"), ["chat", "responses"]);
  return digest(id) && api ? { id, api } : undefined;
}
