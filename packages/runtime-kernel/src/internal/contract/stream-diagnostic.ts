import { addFinishField, observeFinishField, projectFinishAudit, projectToolTerminalAudit, projectProviderHttp, projectProviderRoute, type FinishAudit, type ToolTerminalAudit, type ProviderHttpObservation, type ProviderRouteObservation } from "./provider-observation.ts";
import { projectOwnershipReadObservation, projectOwnershipWaitObservation, type OwnershipWaitObservation, type OwnershipReadObservation } from "./ownership-observation.ts";
import { projectToolIdentityAudit, type ToolIdentityAudit } from "./tool-identity-observation.ts";
import { projectSdkValidation, type SdkValidationObservation } from "./sdk-validation-observation.ts";
/** Payload-free, request-local evidence shared by modeld and the SDK/Effect-free Host. */
export const NORMALIZE_CAUSES = [
  "missing_finish", "unsupported_finish_reason", "open_tools_at_finish", "tool_arguments_invalid",
  "tool_arguments_mismatch", "tool_identity_conflict", "tool_id_collision", "undeclared_tool", "tool_declaration_mismatch",
  "parallel_tools", "sdk_invalid_tool", "sdk_schema_mismatch", "unsupported_provider_state", "unterminated_reasoning", "unsupported_sdk_part", "invalid_event_shape",
  "event_after_finish", "conflicting_finish_reason", "empty_output", "invalid_usage", "invalid_terminal", "terminal_binding_mismatch", "stream_budget",
] as const;
export type NormalizeCause = typeof NORMALIZE_CAUSES[number];
export const STREAM_REJECT_SITES = ["provider_request", "provider_chat_wire", "provider_responses_wire", "sdk_part", "sdk_tool", "sdk_finish", "canonical_event", "canonical_finish", "host_event", "host_tool", "host_terminal", "wire_event", "wire_terminal", "stream_budget", "authority_check"] as const;
export type StreamRejectSite = typeof STREAM_REJECT_SITES[number];
export const STREAM_EVENT_TYPES = ["unknown", "data", "done", "eof", "body_error", "stream-start", "response-metadata", "start", "start-step", "finish-step", "text-start", "text-delta", "text-end", "reasoning", "reasoning-start", "reasoning-delta", "reasoning-end", "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call-streaming-start", "tool-call-delta", "tool-call", "tool-error", "tool-result", "finish", "abort", "error", "raw", "source", "file", "text_delta", "reasoning_delta", "tool_start", "tool_delta", "tool_complete", "backend_finish", "accepted", "terminal", "response.completed", "response.failed", "response.incomplete", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.added", "response.output_item.done"] as const;
export type StreamEventType = typeof STREAM_EVENT_TYPES[number];
export const FINISH_REASONS = ["stop", "end-turn", "tool-calls", "tool_calls", "function_call", "length", "max_tokens", "content-filter", "content_filter", "error", "abort", "aborted", "cancelled", "unknown", "insufficient_system_resource", "completed", "incomplete", "failed", "other"] as const;
export const STREAM_COUNT_KEYS = ["providerEvents", "providerBytes", "sdkParts", "canonicalEvents", "canonicalBytes", "hostEvents", "hostBytes", "textBytes", "reasoningBytes", "toolArgumentBytes", "toolsStarted", "toolsCompleted", "openTools", "requestBytes", "providerFetchCalls", "queuePeak", "eventsSkipped", "eventsDropped", "declaredTools", "hostToolsReleased", "semanticOutputBytes", "replayRecords", "heldToolRecords", "retainedStorageBytes", "httpCalls", "normalizedEmptyToolTypes", "normalizedEmptyFinishReasons", "sdkRawParts", "syntheticDeliveries", "syntheticFinalDeliveries", "auxiliaryEmptyCompletions"] as const;
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
  requestedParallelToolCalls?: boolean;
  hostToolPolicy?: "single-tool" | "validated-batch" | "incremental";
  toolBatchState?: "held" | "released" | "discarded";
  wireToolValidation?: "not_instrumented" | "pending" | "validated" | "rejected" | "incomplete" | "not_applicable";
  finishAudit?: FinishAudit;
  terminalAudit?: ToolTerminalAudit;
  toolIdentity?: ToolIdentityAudit;
  http?: ProviderHttpObservation;
  route?: ProviderRouteObservation;
  engine?: { api: "chat" | "responses"; aiVersion: string; providerVersion: string; adapterRevision: 1 | 2; chatDialect?: "standard" | "minimax-inline-v1"; pipeline?: "provider_v2_single_call" };
};
export const AUTHORITY_REASONS = ["unknown", "authority_unavailable", "authority_not_committed", "host_identity_mismatch", "host_generation_changed", "ownership_reader_unavailable", "ownership_read_unavailable", "ownership_read_timeout", "ownership_gateway_mismatch", "ownership_bridge_unavailable", "server_read_unavailable", "ownership_clock_unavailable", "native_execution_not_ready", "harness_mismatch", "server_id_mismatch", "confirmed_temporal", "ownership_unconfirmed", "ownership_scope_unconfirmed", "ownership_evidence_stale", "ownership_evidence_invalid", "turn_revoked", "ownership_identity_changed"] as const;
export const AUTHORITY_CHECKPOINTS = ["admission", "before_dispatch", "after_auth", "tool_start", "tool_complete", "finish", "recovery"] as const;
export type AuthorityDiagnostic = {
  reason: typeof AUTHORITY_REASONS[number];
  checkpoint?: typeof AUTHORITY_CHECKPOINTS[number];
  durationMs?: number;
  evidenceAgeMs?: number;
  waitBudgetMs?: number;
  ownershipRead?: OwnershipReadObservation;
  ownershipWait?: OwnershipWaitObservation;
};
export type StreamBudgetDiagnostic = { layer: "provider" | "canonical" | "host"; metric: "output_bytes" | "retained_bytes" | "event_count" | "wire_bytes" | "event_bytes" | "tool_count"; limit: number; measured: number };
export type StreamDiagnostic = {
  transportSide?: "host_modeld_ipc";
  transportEvent?: "deadline" | "caller_abort" | "peer_eof" | "socket_error" | "write_error" | "reader_closed";
  failureSummaryStatus?: "direct" | "absent" | "invalid" | "identity_mismatch";
  budget?: StreamBudgetDiagnostic;
  authority?: AuthorityDiagnostic;
  normalizeCause?: NormalizeCause;
  rejectSite?: StreamRejectSite;
  eventType?: StreamEventType;
  declaredToolMatch?: boolean;
  sdkValidation?: SdkValidationObservation;
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
    for (const k of ["providerFinishObserved", "providerDoneObserved", "sdkInvalidToolObserved", "requestedParallelToolCalls"] as const) { const b = own(value, k); if (typeof b === "boolean") out[k] = b; }
    const policy = member(own(value, "hostToolPolicy"), ["single-tool", "validated-batch", "incremental"]);
    if (policy) out.hostToolPolicy = policy;
    const batch = member(own(value, "toolBatchState"), ["held", "released", "discarded"]);
    if (batch) out.toolBatchState = batch;
    const status = own(value, "providerHttpStatus");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) out.providerHttpStatus = status;
    const validation = member(own(value, "wireToolValidation"), ["not_instrumented", "pending", "validated", "rejected", "incomplete", "not_applicable"]);
    if (validation) out.wireToolValidation = validation;
    const finishAudit = projectFinishAudit(own(value, "finishAudit")), terminalAudit = projectToolTerminalAudit(own(value, "terminalAudit"));
    const http = projectProviderHttp(own(value, "http")), route = projectProviderRoute(own(value, "route"));
    if (finishAudit) out.finishAudit = finishAudit;
    if (terminalAudit) out.terminalAudit = terminalAudit;
    const toolIdentity = projectToolIdentityAudit(own(value, "toolIdentity"));
    if (toolIdentity) out.toolIdentity = toolIdentity;
    if (http) out.http = http;
    if (route) out.route = route;
    const engine = own(value, "engine"), api = member(own(engine, "api"), ["chat", "responses"]);
    const aiVersion = own(engine, "aiVersion"), providerVersion = own(engine, "providerVersion");
    if (api && typeof aiVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(aiVersion)
      && typeof providerVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(providerVersion) && (own(engine, "adapterRevision") === 1 || own(engine, "adapterRevision") === 2)) {
      const chatDialect = member(own(engine, "chatDialect"), ["standard", "minimax-inline-v1"]);
      out.engine = { api, aiVersion, providerVersion, adapterRevision: own(engine, "adapterRevision") as 1 | 2, ...(chatDialect ? { chatDialect } : {}), ...(own(engine, "pipeline") === "provider_v2_single_call" ? { pipeline: "provider_v2_single_call" } : {}) };
    }
    return out;
  } catch { return undefined; }
}
export function projectStreamDiagnostic(value: unknown): StreamDiagnostic | undefined {
  try {
    const out: StreamDiagnostic = {};
    if (own(value, "transportSide") === "host_modeld_ipc") out.transportSide = "host_modeld_ipc";
    const transportEvent = member(own(value, "transportEvent"), ["deadline", "caller_abort", "peer_eof", "socket_error", "write_error", "reader_closed"]);
    if (transportEvent && out.transportSide) out.transportEvent = transportEvent;
    const summaryStatus = member(own(value, "failureSummaryStatus"), ["direct", "absent", "invalid", "identity_mismatch"]);
    if (summaryStatus) out.failureSummaryStatus = summaryStatus;
    const cause = member(own(value, "normalizeCause"), NORMALIZE_CAUSES), site = member(own(value, "rejectSite"), STREAM_REJECT_SITES);
    const type = member(own(value, "eventType"), STREAM_EVENT_TYPES), match = own(value, "declaredToolMatch"), seq = count(own(value, "wireSequence"));
    const stream = projectStreamSummary(own(value, "stream"));
    if (cause) out.normalizeCause = cause;
    if (site) out.rejectSite = site;
    if (type) out.eventType = type;
    if (typeof match === "boolean") out.declaredToolMatch = match;
    const sdkValidation = projectSdkValidation(own(value, "sdkValidation"));
    if (sdkValidation) out.sdkValidation = sdkValidation;
    if (seq !== undefined) out.wireSequence = seq;
    if (stream) out.stream = stream;
    const budget = own(value, "budget"), layer = member(own(budget, "layer"), ["provider", "canonical", "host"]);
    const metric = member(own(budget, "metric"), ["output_bytes", "retained_bytes", "event_count", "wire_bytes", "event_bytes", "tool_count"]);
    const limit = count(own(budget, "limit")), measured = count(own(budget, "measured"));
    if (layer && metric && limit !== undefined && measured !== undefined) out.budget = { layer, metric, limit, measured };
    const authority = own(value, "authority"), reason = member(own(authority, "reason"), AUTHORITY_REASONS);
    if (reason) {
      const checkpoint = member(own(authority, "checkpoint"), AUTHORITY_CHECKPOINTS);
      const durationMs = count(own(authority, "durationMs")), evidenceAgeMs = count(own(authority, "evidenceAgeMs"));
      const waitBudgetMs = count(own(authority, "waitBudgetMs"));
      const ownershipRead = projectOwnershipReadObservation(own(authority, "ownershipRead"));
      const ownershipWait = projectOwnershipWaitObservation(own(authority, "ownershipWait"));
      out.authority = { reason, ...(checkpoint ? { checkpoint } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
        ...(evidenceAgeMs !== undefined ? { evidenceAgeMs } : {}), ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
        ...(ownershipRead ? { ownershipRead } : {}), ...(ownershipWait ? { ownershipWait } : {}) };
    }
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
const diagnostics = new WeakMap<object, StreamDiagnostic>();
export function annotateStreamFailure<T extends object>(error: T, value: StreamDiagnostic): T {
  const next = projectStreamDiagnostic(value), prior = diagnostics.get(error);
  // The detecting site/cause wins; later layers may append a later evidence snapshot.
  if (next) diagnostics.set(error, Object.freeze({ ...next, ...prior, ...(next.stream ? { stream: next.stream } : {}), ...(next.authority || prior?.authority ? { authority: { ...next.authority, ...prior?.authority } as AuthorityDiagnostic } : {}) }));
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
  finishField(reason: unknown, present: boolean, sequence: number): void {
    this.value.finishAudit = addFinishField(this.value.finishAudit, observeFinishField(reason, present, sequence));
  }
  terminalAudit(audit: ToolTerminalAudit): void { this.value.terminalAudit = projectToolTerminalAudit(audit); }
  toolIdentity(audit: ToolIdentityAudit): void { this.value.toolIdentity = projectToolIdentityAudit(audit); }
  providerHttp(http: ProviderHttpObservation): void { this.value.http = projectProviderHttp(http); }
  providerRoute(route: ProviderRouteObservation): void { this.value.route = projectProviderRoute(route); }
  sdkFinish(reason: unknown): void { this.value.sdkFinishReason = observedFinishReason(reason); }
  providerDone(): void { this.value.providerDoneObserved = true; }
  httpStatus(n: number): void { this.value.providerHttpStatus = n; }
  invalidTool(): void { this.value.sdkInvalidToolObserved = true; }
  toolValidation(state: NonNullable<StreamSummary["wireToolValidation"]>): void { this.value.wireToolValidation = state; }
  toolPolicy(policy: NonNullable<StreamSummary["hostToolPolicy"]>, requestedParallel: boolean | undefined): void {
    this.value.hostToolPolicy = policy;
    if (requestedParallel !== undefined) this.value.requestedParallelToolCalls = requestedParallel;
  }
  toolBatch(state: NonNullable<StreamSummary["toolBatchState"]>): void { this.value.toolBatchState = state; }
  snapshot(): StreamSummary { this.value.timings.durationMs = this.elapsed(); return projectStreamSummary(this.value)!; }
  private elapsed(): number { return Math.min(MAX_COUNT, Math.max(0, Math.floor(this.now() - this.startedAt))); }
}
