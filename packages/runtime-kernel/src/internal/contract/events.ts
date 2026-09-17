import type { JsonValue } from "./context.ts";
import type { OverflowEvidence } from "./overflow.ts";
import { annotateStreamFailure, type NormalizeCause, type StreamRejectSite, type StreamSummary } from "./stream-diagnostic.ts";

export type InferenceEventName =
  | "text_delta"
  | "reasoning_delta"
  | "tool_start"
  | "tool_delta"
  | "tool_complete"
  | "backend_finish";

export type InferenceUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported subset of completionTokens; absence is unknown, never zero. */
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type InferenceEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | { type: "tool_complete"; toolCallId: string; toolName: string; args: JsonValue }
  | { type: "backend_finish"; finishReason: "stop" | "error" | "abort"; usage?: InferenceUsage; stream?: StreamSummary };

export type BackendFailureCode =
  | "context_budget_exceeded"
  | "unknown_backend_kind"
  | "invalid_prepared_call"
  | "auth_mismatch"
  | "provider_error"
  | "overflow_candidate"
  | "stream_invalid"
  | "stream_limit"
  | "envelope_too_large"
  | "unsupported_content"
  | "unsupported_options"
  | "credential_invalid";

export const BACKEND_FAILURE_CODES: readonly BackendFailureCode[] = [
  "context_budget_exceeded",
  "unknown_backend_kind",
  "invalid_prepared_call",
  "auth_mismatch",
  "provider_error",
  "overflow_candidate",
  "stream_invalid",
  "stream_limit",
  "envelope_too_large",
  "unsupported_content",
  "unsupported_options",
  "credential_invalid",
];

export class BackendFailure extends Error {
  readonly code: BackendFailureCode;
  readonly overflowCandidate: boolean;
  readonly overflowEvidence?: OverflowEvidence;

  constructor(code: BackendFailureCode, extras: { overflowCandidate?: boolean; overflowEvidence?: OverflowEvidence } = {}) {
    super(code);
    this.name = "BackendFailure";
    this.code = code;
    this.overflowCandidate = extras.overflowCandidate === true;
    if (extras.overflowEvidence) this.overflowEvidence = extras.overflowEvidence;
  }
}

export type StreamValidationState = {
  tools: Map<string, string>;
  open: Set<string>;
  finished: boolean;
  sawUsage: boolean;
};

export function emptyStreamValidation(): StreamValidationState {
  return { tools: new Map(), open: new Set(), finished: false, sawUsage: false };
}

export function invalidStream(cause: NormalizeCause, site: StreamRejectSite): BackendFailure {
  return annotateStreamFailure(new BackendFailure("stream_invalid"), { normalizeCause: cause, rejectSite: site });
}
function failStream(cause: NormalizeCause, site: StreamRejectSite = "canonical_event"): never {
  throw invalidStream(cause, site);
}

/** Canonical stream validator. No Host finish.response. Conflicting auth+overflow stays unconfirmed. */
export function applyInferenceEvent(state: StreamValidationState, event: InferenceEvent): StreamValidationState {
  if (state.finished) failStream("event_after_finish");
  if (event.type === "text_delta" || event.type === "reasoning_delta") {
    if (typeof event.text !== "string") failStream("invalid_event_shape");
    return state;
  }
  if (event.type === "tool_start") {
    if (typeof event.toolCallId !== "string" || !event.toolCallId || typeof event.toolName !== "string" || !event.toolName) failStream("invalid_event_shape");
    const existing = state.tools.get(event.toolCallId);
    if (existing && existing !== event.toolName) failStream("tool_identity_conflict");
    state.tools.set(event.toolCallId, event.toolName);
    state.open.add(event.toolCallId);
    return state;
  }
  if (event.type === "tool_delta" || event.type === "tool_complete") {
    const named = state.tools.get(event.toolCallId);
    if (!named || named !== event.toolName) failStream("tool_identity_conflict");
    if (event.type === "tool_delta" && typeof event.argsTextDelta !== "string") failStream("invalid_event_shape");
    if (event.type === "tool_complete") {
      if (event.args === undefined) failStream("tool_arguments_invalid");
      state.open.delete(event.toolCallId);
    }
    return state;
  }
  if (event.type === "backend_finish") {
    if (event.finishReason !== "stop" && event.finishReason !== "error" && event.finishReason !== "abort") failStream("unsupported_finish_reason", "canonical_finish");
    if (event.finishReason === "stop" && state.open.size > 0) failStream("open_tools_at_finish", "canonical_finish");
    state.finished = true;
    state.sawUsage = event.usage !== undefined;
    return state;
  }
  failStream("invalid_event_shape");
}

export function finishInferenceStream(state: StreamValidationState): void {
  if (!state.finished) failStream("missing_finish", "canonical_finish");
  if (state.open.size > 0) failStream("open_tools_at_finish", "canonical_finish");
}

export function classifyProviderFailure(input: {
  auth?: boolean;
  overflow?: boolean;
}): BackendFailure {
  if (input.auth && input.overflow) return new BackendFailure("provider_error", { overflowCandidate: false });
  if (input.overflow) return new BackendFailure("overflow_candidate", { overflowCandidate: true });
  if (input.auth) return new BackendFailure("provider_error", { overflowCandidate: false });
  return new BackendFailure("provider_error", { overflowCandidate: false });
}
