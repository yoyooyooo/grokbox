import type { JsonValue } from "./context.ts";
import type { OverflowEvidence } from "./overflow.ts";

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
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type InferenceEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | { type: "tool_complete"; toolCallId: string; toolName: string; args: JsonValue }
  | { type: "backend_finish"; finishReason: "stop" | "error" | "abort"; usage?: InferenceUsage };

export type BackendFailureCode =
  | "unknown_backend_kind"
  | "invalid_prepared_call"
  | "auth_mismatch"
  | "provider_error"
  | "overflow_candidate"
  | "stream_invalid"
  | "envelope_too_large"
  | "unsupported_content"
  | "unsupported_options"
  | "credential_invalid";

export const BACKEND_FAILURE_CODES: readonly BackendFailureCode[] = [
  "unknown_backend_kind",
  "invalid_prepared_call",
  "auth_mismatch",
  "provider_error",
  "overflow_candidate",
  "stream_invalid",
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

function failStream(): never {
  throw new BackendFailure("stream_invalid");
}

/** Canonical stream validator. No Host finish.response. Conflicting auth+overflow stays unconfirmed. */
export function applyInferenceEvent(state: StreamValidationState, event: InferenceEvent): StreamValidationState {
  if (state.finished) failStream();
  if (event.type === "text_delta" || event.type === "reasoning_delta") {
    if (typeof event.text !== "string") failStream();
    return state;
  }
  if (event.type === "tool_start") {
    if (!event.toolCallId || !event.toolName) failStream();
    const existing = state.tools.get(event.toolCallId);
    if (existing && existing !== event.toolName) failStream();
    state.tools.set(event.toolCallId, event.toolName);
    state.open.add(event.toolCallId);
    return state;
  }
  if (event.type === "tool_delta" || event.type === "tool_complete") {
    const named = state.tools.get(event.toolCallId);
    if (!named || named !== event.toolName) failStream();
    if (event.type === "tool_complete") {
      if (event.args === undefined) failStream();
      state.open.delete(event.toolCallId);
    }
    return state;
  }
  if (event.type === "backend_finish") {
    if (event.finishReason !== "stop" && event.finishReason !== "error" && event.finishReason !== "abort") failStream();
    state.finished = true;
    state.sawUsage = event.usage !== undefined;
    return state;
  }
  failStream();
}

export function finishInferenceStream(state: StreamValidationState): void {
  if (!state.finished || state.open.size > 0) failStream();
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
