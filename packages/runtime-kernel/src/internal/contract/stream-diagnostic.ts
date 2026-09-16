/** Payload-free, request-local evidence shared by modeld and the SDK/Effect-free Host. */
export const NORMALIZE_CAUSES = [
  "missing_finish", "unsupported_finish_reason", "open_tools_at_finish", "tool_arguments_invalid",
  "tool_arguments_mismatch", "tool_identity_conflict", "tool_id_collision", "undeclared_tool",
  "parallel_tools", "sdk_invalid_tool", "unsupported_sdk_part", "invalid_event_shape",
  "event_after_finish", "empty_output", "invalid_usage", "invalid_terminal", "terminal_binding_mismatch", "stream_budget",
] as const;
export type NormalizeCause = typeof NORMALIZE_CAUSES[number];
export const STREAM_REJECT_SITES = ["provider_chat_wire", "provider_responses_wire", "sdk_part", "sdk_tool", "sdk_finish", "canonical_event", "canonical_finish", "host_event", "host_tool", "host_terminal", "wire_event", "wire_terminal", "stream_budget"] as const;
export type StreamRejectSite = typeof STREAM_REJECT_SITES[number];
export const STREAM_EVENT_TYPES = ["unknown", "data", "done", "eof", "body_error", "stream-start", "response-metadata", "start", "start-step", "finish-step", "text-start", "text-delta", "text-end", "reasoning", "reasoning-start", "reasoning-delta", "reasoning-end", "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call-streaming-start", "tool-call-delta", "tool-call", "tool-error", "tool-result", "finish", "abort", "error", "raw", "source", "file", "text_delta", "reasoning_delta", "tool_start", "tool_delta", "tool_complete", "backend_finish", "accepted", "terminal", "response.completed", "response.failed", "response.incomplete", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.added", "response.output_item.done"] as const;
export type StreamEventType = typeof STREAM_EVENT_TYPES[number];
export const FINISH_REASONS = ["stop", "end-turn", "tool-calls", "tool_calls", "function_call", "length", "max_tokens", "content-filter", "content_filter", "error", "abort", "aborted", "cancelled", "unknown", "insufficient_system_resource", "completed", "incomplete", "failed", "other"] as const;
export const STREAM_COUNT_KEYS = ["providerEvents", "providerBytes", "sdkParts", "canonicalEvents", "canonicalBytes", "hostEvents", "hostBytes", "textBytes", "reasoningBytes", "toolArgumentBytes", "toolsStarted", "toolsCompleted", "openTools", "requestBytes", "queuePeak", "eventsSkipped", "eventsDropped", "declaredTools", "hostToolsReleased"] as const;
export type StreamCountKey = typeof STREAM_COUNT_KEYS[number];
export const STREAM_TIME_KEYS = ["headersMs", "providerFirstEventMs", "sdkFirstPartMs", "canonicalFirstEventMs", "hostFirstEventMs", "durationMs"] as const;
export type StreamTimeKey = typeof STREAM_TIME_KEYS[number];
export const STREAM_TAIL_MAX = 32;
const MAX_COUNT = 1024 * 1024 * 1024;
const LAYERS = ["provider", "sdk", "canonical", "host", "wire"] as const;
type EvidenceLayer = typeof LAYERS[number];
export type StreamSummary = {
  version: 1;
  counts: Partial<Record<StreamCountKey, number>>;
  timings: Partial<Record<StreamTimeKey, number>>;
  tail: Array<{ layer: EvidenceLayer; type: StreamEventType; sequence: number; elapsedMs: number; bytes?: number }>;
  providerObservation?: "not_started" | "headers" | "stream" | "eof" | "body_error" | "cancelled";
  providerFinishReason?: typeof FINISH_REASONS[number];
  sdkFinishReason?: typeof FINISH_REASONS[number];
  providerFinishObserved?: boolean;
  providerDoneObserved?: boolean;
  providerHttpStatus?: number;
  sdkInvalidToolObserved?: boolean;
  wireToolValidation?: "not_instrumented" | "pending" | "validated" | "rejected";
  engine?: { api: "chat" | "responses"; aiVersion: string; providerVersion: string; adapterRevision: 1; pipeline?: "provider_v2_single_call" };
};
export type StreamDiagnostic = {
  normalizeCause?: NormalizeCause;
  rejectSite?: StreamRejectSite;
  eventType?: StreamEventType;
  declaredToolMatch?: boolean;
  wireSequence?: number;
  stream?: StreamSummary;
};
function own(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : undefined;
}
export function observedStreamType(value: unknown): StreamEventType { return member(value, STREAM_EVENT_TYPES) ?? "unknown"; }
export function observedFinishReason(value: unknown): typeof FINISH_REASONS[number] { return member(value, FINISH_REASONS) ?? "other"; }
/** Unknown is omission, never a fabricated zero. No accessors or free-form strings are copied. */
export function projectStreamSummary(value: unknown): StreamSummary | undefined {
  try {
    if (own(value, "version") !== 1) return undefined;
    const out: StreamSummary = { version: 1, counts: {}, timings: {}, tail: [] };
    for (const k of STREAM_COUNT_KEYS) { const n = count(own(own(value, "counts"), k)); if (n !== undefined) out.counts[k] = n; }
    for (const k of STREAM_TIME_KEYS) { const n = count(own(own(value, "timings"), k)); if (n !== undefined) out.timings[k] = n; }
    const tail = own(value, "tail");
    if (Array.isArray(tail)) for (let i = Math.max(0, tail.length - STREAM_TAIL_MAX); i < tail.length; i++) {
      const item = own(tail, String(i));
      const layer = member(own(item, "layer"), LAYERS), type = member(own(item, "type"), STREAM_EVENT_TYPES);
      const sequence = count(own(item, "sequence")), elapsedMs = count(own(item, "elapsedMs")), bytes = count(own(item, "bytes"));
      if (layer && type && sequence !== undefined && elapsedMs !== undefined) out.tail.push({ layer, type, sequence, elapsedMs, ...(bytes !== undefined ? { bytes } : {}) });
    }
    const state = member(own(value, "providerObservation"), ["not_started", "headers", "stream", "eof", "body_error", "cancelled"]);
    if (state) out.providerObservation = state;
    for (const k of ["providerFinishReason", "sdkFinishReason"] as const) { const r = member(own(value, k), FINISH_REASONS); if (r) out[k] = r; }
    for (const k of ["providerFinishObserved", "providerDoneObserved", "sdkInvalidToolObserved"] as const) { const b = own(value, k); if (typeof b === "boolean") out[k] = b; }
    const status = own(value, "providerHttpStatus");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) out.providerHttpStatus = status;
    const validation = member(own(value, "wireToolValidation"), ["not_instrumented", "pending", "validated", "rejected"]);
    if (validation) out.wireToolValidation = validation;
    const engine = own(value, "engine"), api = member(own(engine, "api"), ["chat", "responses"]);
    const aiVersion = own(engine, "aiVersion"), providerVersion = own(engine, "providerVersion");
    if (api && typeof aiVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(aiVersion)
      && typeof providerVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(providerVersion) && own(engine, "adapterRevision") === 1) {
      out.engine = { api, aiVersion, providerVersion, adapterRevision: 1, ...(own(engine, "pipeline") === "provider_v2_single_call" ? { pipeline: "provider_v2_single_call" } : {}) };
    }
    return out;
  } catch { return undefined; }
}
export function projectStreamDiagnostic(value: unknown): StreamDiagnostic | undefined {
  try {
    const out: StreamDiagnostic = {};
    const cause = member(own(value, "normalizeCause"), NORMALIZE_CAUSES), site = member(own(value, "rejectSite"), STREAM_REJECT_SITES);
    const type = member(own(value, "eventType"), STREAM_EVENT_TYPES), match = own(value, "declaredToolMatch"), seq = count(own(value, "wireSequence"));
    const stream = projectStreamSummary(own(value, "stream"));
    if (cause) out.normalizeCause = cause;
    if (site) out.rejectSite = site;
    if (type) out.eventType = type;
    if (typeof match === "boolean") out.declaredToolMatch = match;
    if (seq !== undefined) out.wireSequence = seq;
    if (stream) out.stream = stream;
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
const diagnostics = new WeakMap<object, StreamDiagnostic>();
export function annotateStreamFailure<T extends object>(error: T, value: StreamDiagnostic): T {
  const next = projectStreamDiagnostic(value), prior = diagnostics.get(error);
  // The detecting site/cause wins; later layers may append a later evidence snapshot.
  if (next) diagnostics.set(error, Object.freeze({ ...next, ...prior, ...(next.stream ? { stream: next.stream } : {}) }));
  return error;
}
export function streamFailureDiagnostic(value: unknown): StreamDiagnostic | undefined {
  return value !== null && typeof value === "object" ? projectStreamDiagnostic(diagnostics.get(value)) : undefined;
}
export class StreamEvidence {
  private readonly startedAt: number;
  private readonly sequence: Record<EvidenceLayer, number> = { provider: 0, sdk: 0, canonical: 0, host: 0, wire: 0 };
  private readonly value: StreamSummary = { version: 1, counts: {}, timings: {}, tail: [] };
  constructor(private readonly now: () => number = () => performance.now()) { this.startedAt = now(); }
  engine(value: NonNullable<StreamSummary["engine"]>): void { this.value.engine = { ...value }; }
  setCount(key: StreamCountKey, n: number): void { if (count(n) !== undefined) this.value.counts[key] = n; }
  increment(key: StreamCountKey, amount = 1): void { this.setCount(key, Math.min(MAX_COUNT, (this.value.counts[key] ?? 0) + amount)); }
  note(layer: EvidenceLayer, type: unknown, bytes?: number): void {
    this.value.tail.push({ layer, type: observedStreamType(type), sequence: this.sequence[layer]++, elapsedMs: this.elapsed(), ...(count(bytes) !== undefined ? { bytes } : {}) });
    if (this.value.tail.length > STREAM_TAIL_MAX) this.value.tail.shift();
  }
  first(key: StreamTimeKey): void { if (this.value.timings[key] === undefined) this.value.timings[key] = this.elapsed(); }
  provider(state: NonNullable<StreamSummary["providerObservation"]>): void { this.value.providerObservation = state; }
  providerStarted(): void { this.provider("not_started"); }
  /** Explicit false is justified only after an SSE reader has actually been installed. */
  instrumented(): void { this.value.providerFinishObserved = false; this.value.providerDoneObserved = false; this.value.wireToolValidation = "pending"; }
  providerFinish(reason: unknown): void { this.value.providerFinishObserved = true; this.value.providerFinishReason = observedFinishReason(reason); }
  sdkFinish(reason: unknown): void { this.value.sdkFinishReason = observedFinishReason(reason); }
  providerDone(): void { this.value.providerDoneObserved = true; }
  httpStatus(n: number): void { this.value.providerHttpStatus = n; }
  invalidTool(): void { this.value.sdkInvalidToolObserved = true; }
  toolValidation(state: NonNullable<StreamSummary["wireToolValidation"]>): void { this.value.wireToolValidation = state; }
  snapshot(): StreamSummary { this.value.timings.durationMs = this.elapsed(); return projectStreamSummary(this.value)!; }
  private elapsed(): number { return Math.min(MAX_COUNT, Math.max(0, Math.floor(this.now() - this.startedAt))); }
}
