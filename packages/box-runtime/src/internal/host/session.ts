import { randomUUID } from "node:crypto";
import { attachFailureLink } from "./alert-provenance.ts";
import { declaredTextEndTurn } from "./delivery-fallback.ts";
import { isDeepStrictEqual } from "node:util";
import { cloneJson, envelopeHasImage, EnvelopeError, parseModelEnvelope,
  type EnvelopeErrorCode, type ModelEnvelope, type PromptContentPart, type PromptMessage, type ToolCall } from "@grokbox/runtime-kernel/contract";
import { STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { buildHostEnvelope, cloneHostExecutorWindow, HostStateCodecError, type HostStateShape } from "./context-codec.ts";
import { replayStream } from "./replay-stream.ts";
import { combineAbortSignals } from "./abort-signals.ts";
import { grokboxAuxFrom, type GrokboxAuxRequest } from "./aux-request.ts";
import { INVALID_STREAM_AGENT_MESSAGE, LEDGER_UNAVAILABLE_AGENT_MESSAGE, AUTHORITY_AGENT_MESSAGE, LOCAL_TRANSPORT_AGENT_MESSAGE } from "./failure-catalog.ts";
import { StreamOutputBudget, ChunkedText, STREAM_STORAGE_CHARS, type InferenceEvent, StreamEvidence, annotateStreamFailure, streamFailureDiagnostic, projectStreamDiagnostic, projectFailureSummary, annotateFailureSummary, failureSummaryOf, presentFailure, type FailureSummary, type StreamDiagnostic } from "@grokbox/runtime-kernel/contract";
export type { ModelEnvelope, PromptContentPart, PromptMessage } from "@grokbox/runtime-kernel/contract";

export type FinishReason = "stop" | "error" | "abort";
export type HostFinishReason = FinishReason | "tool-calls";
export type StreamPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning"; textDelta: string }
  | { type: "tool-call-streaming-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "error"; error: VisibleFailure }
  | { type: "finish"; reason: FinishReason; finishReason?: HostFinishReason; usage?: HostUsage; response?: HostResponse };
export type SessionTextContentPart = { type: "text"; text: string };
export type SessionMessage = {
  role: "assistant";
  content: string | Array<SessionTextContentPart | ToolCall | { type: "reasoning"; text: string }>;
};
export type HostUsage = {
  promptTokens: number; completionTokens: number; totalTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number;
};
export type VisibleFailureStage = "admit" | "provider" | "normalize" | "authority" | "transport";
export type VisibleFailure = {
  failureId?: string;
  userVisible: true;
  code: string;
  message: string;
  toolCallIds?: string[];
  agentId?: string;
  invocationId?: string;
  stage?: VisibleFailureStage;
  diagnostic?: StreamDiagnostic;
  failureSummary?: FailureSummary;
  presentation?: ReturnType<typeof presentFailure>;
};
export type VisibleFailureContext = {
  agentId?: string;
  invocationId?: string;
  stage?: VisibleFailureStage;
  diagnostic?: StreamDiagnostic;
  failureSummary?: FailureSummary;
  receivedOutput?: boolean;
};
export type HostResponse = { modelId: string; messages: SessionMessage[]; finishReason?: HostFinishReason; error?: VisibleFailure };
export type StreamHandle = { fullStream: AsyncIterable<StreamPart>; response: Promise<HostResponse>; usage: Promise<HostUsage> };
export type StreamRequest = {
  messages?: PromptMessage[];
  envelope?: ModelEnvelope;
  invocationId?: string;
  abortSignal?: AbortSignal;
  aux?: GrokboxAuxRequest;
};
export type PromptSession = { stream: (request?: StreamRequest) => StreamHandle };
export type ExtendedUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number };
export type HostStreamResult = StreamHandle & {
  extendedUsage: Promise<ExtendedUsage>; providerMetadata: Promise<Record<string, unknown>>; invocationId: Promise<unknown>;
};
// Process-local provenance, not provider-supplied codes/names/text. Bounded cause traversal
// preserves this fact through native wrapping without admitting arbitrary provider errors.
const managedFailures = new WeakSet<object>();
/** Called only by a trusted local adapter/refusal or owned native STEP scope,
 * never by interpreting a provider-supplied error code or message. */
export function recordHostManagedFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  managedFailures.add(error);
  return true;
}
export function isHostManagedFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (managedFailures.has(current)) return true;
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (!cause || !Object.hasOwn(cause, "value") || cause.value === current) return false;
    current = cause.value;
  }
  return false;
}

export class InvalidHostStateError extends EnvelopeError {
  readonly name = "InvalidHostStateError";
  constructor(code: EnvelopeErrorCode = "invalid_envelope") {
    super(code);
    managedFailures.add(this);
  }
}
export type HostPromptExecutor = {
  appendMessages: (messages?: unknown) => HostPromptExecutor;
  getMessages: () => unknown[]; getState: () => unknown[]; clearMessages: () => void;
  stream: (ctx?: unknown, invocationId?: unknown, tools?: unknown, options?: unknown) => HostStreamResult;
};
export type HostPromptSession = {
  getModelId: () => string;
  getExecutor: (state?: unknown) => HostPromptExecutor;
  getExecutorWithoutResolvedModelTracking: (state?: unknown) => HostPromptExecutor;
};
export function isHostPromptSession(value: unknown): value is HostPromptSession {
  if (value === null || typeof value !== "object") return false;
  const session = value as Partial<HostPromptSession>;
  return typeof session.getModelId === "function" && typeof session.getExecutor === "function" && typeof session.getExecutorWithoutResolvedModelTracking === "function";
}

function abortSignalFrom(ctx: unknown, options: unknown): ReturnType<typeof combineAbortSignals> {
  const signals: AbortSignal[] = [];
  for (const value of [ctx, options]) {
    if (!value || typeof value !== "object") continue;
    for (const signal of [(value as { signal?: unknown }).signal, (value as { abortSignal?: unknown }).abortSignal]) {
      if (signal instanceof AbortSignal && !signals.includes(signal)) signals.push(signal);
    }
  }
  return combineAbortSignals(signals);
}
function numberOrZero(value: unknown): number { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function optionalCacheTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
export function normalizeHostUsage(usage: unknown): HostUsage {
  const u = usage !== null && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const promptTokens = numberOrZero(u.promptTokens ?? u.prompt_tokens ?? u.inputTokens ?? u.input_tokens);
  const completionTokens = numberOrZero(u.completionTokens ?? u.completion_tokens ?? u.outputTokens ?? u.output_tokens);
  const cacheReadTokens = optionalCacheTokens(u.cacheReadTokens ?? u.cache_read_tokens ?? u.cachedInputTokens);
  const cacheWriteTokens = optionalCacheTokens(u.cacheWriteTokens ?? u.cache_write_tokens);
  return {
    promptTokens, completionTokens, totalTokens: numberOrZero(u.totalTokens ?? u.total_tokens) || promptTokens + completionTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}
function measuredHostUsage(raw: unknown): HostUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const prompt = rec.promptTokens ?? rec.prompt_tokens ?? rec.inputTokens ?? rec.input_tokens;
  const completion = rec.completionTokens ?? rec.completion_tokens ?? rec.outputTokens ?? rec.output_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || !Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
    return undefined;
  }
  return normalizeHostUsage(raw);
}
export function projectExtendedUsage(usage: HostUsage, contextWindowTokens?: number): ExtendedUsage {
  const maxTokens = typeof contextWindowTokens === "number" && Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
    ? contextWindowTokens : 0;
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    maxTokens,
  };
}
export function normalizeHostResponse(value: unknown): HostResponse {
  const record = value !== null && typeof value === "object" ? value as HostResponse : { modelId: "", messages: [] };
  const messages = (record.messages ?? []).map((message) => {
    const content: Exclude<SessionMessage["content"], string> = typeof message.content === "string"
      ? (message.content ? [{ type: "text", text: message.content }] : []) : structuredClone(message.content);
    return { role: "assistant" as const, content };
  });
  return { modelId: typeof record.modelId === "string" ? record.modelId : "", messages: messages.length ? messages : [{ role: "assistant", content: [] }],
    ...(record.finishReason ? { finishReason: record.finishReason } : {}), ...(record.error ? { error: structuredClone(record.error) } : {}) };
}
/** Error Host `classifyError2` wraps as RetriableError → runTurn catch → official tray. Not assistant text. */
export function hostVisibleStreamError(failure: VisibleFailure): Error {
  const err = new Error(failure.message);
  attachFailureLink(err, failure);
  managedFailures.add(err);
  if (failure.diagnostic) annotateStreamFailure(err, failure.diagnostic);
  if (failure.failureSummary) annotateFailureSummary(err, failure.failureSummary);
  err.name = "RetriableError";
  Object.defineProperty(err, "kind", { value: "RetriableError", enumerable: true });
  Object.assign(err, {
    code: failure.code,
    userVisible: true as const,
    ...(failure.toolCallIds ? { toolCallIds: failure.toolCallIds } : {}),
    ...(failure.stage ? { stage: failure.stage } : {}),
    ...(failure.agentId ? { agentId: failure.agentId } : {}),
    ...(failure.invocationId ? { invocationId: failure.invocationId } : {}),
  });
  return err;
}

function settleRejected(thrown: Error): { response: Promise<HostResponse>; usage: Promise<HostUsage> } {
  const response = Promise.reject(thrown);
  const usage = Promise.reject(thrown);
  void response.catch(() => undefined);
  void usage.catch(() => undefined);
  return { response, usage };
}

export function toHostStreamResult(handle: StreamHandle, invocationId?: unknown, capacity?: { contextWindowTokens?: number }): HostStreamResult {
  const usage = handle.usage.then(normalizeHostUsage);
  const response = handle.response.then(normalizeHostResponse);
  const extendedUsage = usage.then((u) => projectExtendedUsage(u, capacity?.contextWindowTokens));
  void usage.catch(() => undefined);
  void response.catch(() => undefined);
  void extendedUsage.catch(() => undefined);
  return {
    fullStream: { [Symbol.asyncIterator]() {
      const iterator = handle.fullStream[Symbol.asyncIterator]();
      return {
        async next() {
          const next = await iterator.next();
          if (next.done) return next;
          const part = next.value;
          if (part.type === "error") {
            const raw = part.error;
            if (raw instanceof Error) throw raw;
            const vis = raw && typeof raw === "object" && raw.userVisible === true && typeof raw.code === "string"
              ? raw : failure("model_error");
            throw hostVisibleStreamError(vis);
          }
          if (part.type === "text-delta" || part.type === "reasoning") {
            return { done: false as const, value: { ...part, text: part.textDelta } as unknown as StreamPart };
          }
          return { done: false as const, value: part.type === "finish" && part.response
            ? { ...part, response: normalizeHostResponse(part.response) } : part };
        },
        async return() { return await iterator.return?.() ?? { done: true as const, value: undefined }; },
      };
    } },
    response, usage, extendedUsage,
    providerMetadata: Promise.resolve({}), invocationId: Promise.resolve(invocationId),
  };
}

export type HostStreamRejectDetail = {
  invocationId?: unknown;
  reason?: "missing-step-id" | "invalid-step-id" | "invalid-state";
  stage?: "stream-id" | "admit" | "normalize";
};
export function asHostPromptSession(session: PromptSession, modelId: string, onRequestId?: (id: string) => void,
  input: { invocationId?: string; requireStepId?: boolean; contextWindowTokens?: number; onInvalidState?: (code: EnvelopeErrorCode, shape?: HostStateShape) => void; reject?: (code: string, detail?: HostStreamRejectDetail) => StreamHandle } = {}): HostPromptSession {
  const notified = new Set<string>();
  const createExecutor = (state?: unknown): HostPromptExecutor => {
    let messages: ReturnType<typeof cloneHostExecutorWindow> = [];
    let invalidCode: EnvelopeErrorCode | undefined;
    let invalidReported = false;
    let invalidShape: HostStateShape | undefined;
    const reportInvalid = () => {
      if (!invalidCode || invalidReported) return;
      invalidReported = true;
      try { input.onInvalidState?.(invalidCode, invalidShape); } catch { /* Observation cannot change Host state. */ }
    };
    if (state !== undefined) {
      try { messages = cloneHostExecutorWindow(state); }
      catch (error) {
        invalidCode = error instanceof EnvelopeError ? error.code : "invalid_envelope";
        invalidShape = error instanceof HostStateCodecError ? error.stateShape : undefined;
        reportInvalid();
      }
    }
    const read = (): unknown[] => {
      if (invalidCode) throw new InvalidHostStateError(invalidCode);
      return structuredClone(messages);
    };
    const executor: HostPromptExecutor = {
      appendMessages(next) {
        if (invalidCode) return executor;
        try {
          const batch = cloneHostExecutorWindow(next == null ? [] : next);
          messages = [...messages, ...batch];
        } catch (error) {
          invalidCode = error instanceof EnvelopeError ? error.code : "invalid_envelope";
          invalidShape = error instanceof HostStateCodecError ? error.stateShape : undefined;
          reportInvalid();
        }
        return executor;
      },
      getMessages: read,
      getState: read,
      clearMessages() { messages = []; invalidCode = undefined; invalidReported = false; invalidShape = undefined; },
      stream(ctx, invocationId, tools, options) {
        const aux = grokboxAuxFrom(ctx) ?? grokboxAuxFrom(options);
        const requestId = aux
          ? aux.auxRequestId
          : (input.requireStepId ? invocationId : (invocationId ?? input.invocationId));
        let cancellation: ReturnType<typeof combineAbortSignals> | undefined;
        try {
          if (aux) {
            if (boundedVisible(invocationId)) throw new EnvelopeError("invalid_envelope", "invalid-step-id");
            if (aux.parent.modelId !== modelId) throw new EnvelopeError("invalid_envelope");
          } else if (input.requireStepId) {
            if (requestId === undefined) throw new EnvelopeError("invalid_envelope", "missing-step-id");
            if (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\x00-\x1f]/.test(requestId)) {
              throw new EnvelopeError("invalid_envelope", "invalid-step-id");
            }
          } else if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\x00-\x1f]/.test(requestId))) {
            throw new EnvelopeError("invalid_envelope");
          }
          cancellation = abortSignalFrom(ctx, options);
          const signal = cancellation.signal;
          if (invalidCode && !signal?.aborted) throw new InvalidHostStateError(invalidCode);
          if (!signal?.aborted && modelId !== STUB_ECHO_MODEL_ID) {
            const window = input.contextWindowTokens;
            if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
              throw new EnvelopeError("invalid_envelope");
            }
          }
          const envelope = signal?.aborted ? buildHostEnvelope([]) : buildHostEnvelope(messages, tools, options);
          const handle = session.stream({
            envelope,
            abortSignal: signal,
            ...(typeof requestId === "string" ? { invocationId: requestId } : {}),
            ...(aux ? { aux } : {}),
          });
          void handle.response.then(cancellation.dispose, cancellation.dispose);
          if (!aux && typeof requestId === "string" && !notified.has(requestId)) {
            notified.add(requestId);
            try { onRequestId?.(requestId); } catch { /* Host notification is not a model effect. */ }
          }
          return toHostStreamResult(handle, requestId, { contextWindowTokens: input.contextWindowTokens });
        } catch (error) {
          cancellation?.dispose();
          const code = error instanceof EnvelopeError ? error.code : "invalid_envelope";
          const reason = error instanceof EnvelopeError ? error.stepReason : undefined;
          const stage = reason === "missing-step-id" || reason === "invalid-step-id" ? "stream-id" : "admit";
          return toHostStreamResult(
            input.reject?.(code, {
              invocationId: requestId,
              reason: reason ?? "invalid-state",
              stage,
            }) ?? visibleFailureHandle(modelId, code),
            requestId,
            { contextWindowTokens: input.contextWindowTokens },
          );
        }
      },
    };
    return executor;
  };
  return { getModelId: () => modelId, getExecutor: createExecutor, getExecutorWithoutResolvedModelTracking: createExecutor };
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
export const STREAM_MAX_BYTES = 1024 * 1024;
// Resource guard for retained representation, not a count of received fragments.
export const STREAM_RETAINED_BYTES = 8 * STREAM_MAX_BYTES;
function budgetEvent(part: StreamPart): InferenceEvent | undefined {
  if (part.type === "text-delta" || part.type === "reasoning") return { type: part.type === "text-delta" ? "text_delta" : "reasoning_delta", text: part.textDelta };
  if (part.type === "tool-call-streaming-start") return { type: "tool_start", toolCallId: part.toolCallId, toolName: part.toolName };
  if (part.type === "tool-call-delta") return { type: "tool_delta", toolCallId: part.toolCallId, toolName: part.toolName, argsTextDelta: part.argsTextDelta };
  if (part.type === "tool-call") return { type: "tool_complete", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args as never };
}

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_image: "Configured model does not accept images. No model request was sent.",
  parallel_tools: "Parallel tool calls are not supported. Rejected calls were not executed.",
  invalid_envelope: "The model request could not be converted safely. No model request was sent.",
  unsupported_content: "The message contains unsupported content. No model request was sent.",
  invalid_tools: "Tool definitions could not be converted safely. No model request was sent.",
  unsupported_options: "The model request contains unsupported options. No model request was sent.",
  envelope_too_large: "The model request exceeds the supported envelope limit. No model request was sent.",
  stream_limit: "The model stream exceeded its safety limit and was stopped.",
  capacity: "The local model runtime could not accept this work because execution resources were unavailable.",
  ledger_unavailable: LEDGER_UNAVAILABLE_AGENT_MESSAGE,
  invalid_stream: INVALID_STREAM_AGENT_MESSAGE,
  transport_error: LOCAL_TRANSPORT_AGENT_MESSAGE,
  invocation_conflict: "This invocation was already used with different inputs. It was not dispatched again.",
  not_admitted: AUTHORITY_AGENT_MESSAGE,
  model_error: "The configured model request failed. No fallback model was used.",
  unsupported_version: "The local Host and model runtime use incompatible protocol versions. Update them together. No model request was dispatched.",
};
const VISIBLE_STAGES = new Set<VisibleFailureStage>(["admit", "provider", "normalize", "authority", "transport"]);
function hostVisibleCode(code: string): string {
  const mapped = code === "stream_invalid" ? "invalid_stream" : code;
  return Object.hasOwn(FAILURE_MESSAGES, mapped) ? mapped : "model_error";
}
function boundedVisible(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : undefined;
}
function visibleContext(ctx?: VisibleFailureContext): VisibleFailureContext {
  const agentId = boundedVisible(ctx?.agentId);
  const invocationId = boundedVisible(ctx?.invocationId);
  const stage = ctx?.stage && VISIBLE_STAGES.has(ctx.stage) ? ctx.stage : undefined;
  return { ...(agentId ? { agentId } : {}), ...(invocationId ? { invocationId } : {}), ...(stage ? { stage } : {}),
    ...(projectStreamDiagnostic(ctx?.diagnostic) ? { diagnostic: projectStreamDiagnostic(ctx?.diagnostic) } : {}),
    ...(projectFailureSummary(ctx?.failureSummary) ? { failureSummary: projectFailureSummary(ctx?.failureSummary) } : {}),
    ...(typeof ctx?.receivedOutput === "boolean" ? { receivedOutput: ctx.receivedOutput } : {}) };
}
function failure(code: string, ids?: string[], ctx?: VisibleFailureContext): VisibleFailure {
  const resolved = hostVisibleCode(code);
  const extra = visibleContext(ctx);
  const bits = [
    extra.agentId ? `agentId=${extra.agentId}` : undefined,
    extra.invocationId ? `invocationId=${extra.invocationId}` : undefined,
    extra.stage ? `stage=${extra.stage}` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  const presentation = extra.failureSummary ? presentFailure(extra.failureSummary, {
    receivedOutput: extra.receivedOutput, toolsReleased: extra.diagnostic?.stream?.counts.hostToolsReleased,
  }) : undefined;
  const primaryMessage = presentation?.message ?? FAILURE_MESSAGES[resolved] ?? FAILURE_MESSAGES.model_error!;
  const message = bits.length ? `${primaryMessage} (${bits.join(" ")})` : primaryMessage;
  const error: VisibleFailure = {
    userVisible: true, code: resolved, message, failureId: extra.failureSummary?.failureId ?? randomUUID(),
    ...(presentation ? { presentation } : {}),
    ...(ids?.length ? { toolCallIds: [...ids] } : {}),
    ...extra,
  };
  Object.defineProperty(error, "toString", { value: () => error.message, enumerable: false });
  return error;
}
export class VisibleStreamError extends Error {
  readonly code: string;
  readonly stage: VisibleFailureStage;
  constructor(stage: VisibleFailureStage, code = "model_error", message?: string) {
    const resolved = hostVisibleCode(code);
    super(message ?? resolved);
    this.code = resolved;
    this.stage = resolved === "not_admitted" ? (stage === "admit" ? "admit" : "authority")
      : resolved === "transport_error" ? "transport"
      : resolved === "invalid_stream" || resolved === "stream_limit" ? "normalize"
      : VISIBLE_STAGES.has(stage) ? stage : "provider";
  }
}
export type SessionTerminal = {
  failureId?: string;
  terminalClass: FinishReason; toolCallCount: number; rejected?: boolean; errorCode?: string; stage?: VisibleFailureStage; invocationId?: string;
  diagnostic?: StreamDiagnostic;
  failureSummary?: FailureSummary;
  presentation?: ReturnType<typeof presentFailure>;
  purpose?: "main" | "memory-extraction" | "episode";
  parentStepId?: string;
};
function notify(onTerminal: ((terminal: SessionTerminal) => void) | undefined, terminal: SessionTerminal) {
  try { onTerminal?.(terminal); } catch { /* Evidence is not the Host loop. */ }
}
export function visibleFailureHandle(modelId: string, code: string, ids?: string[], onTerminal?: (terminal: SessionTerminal) => void,
  ctx?: VisibleFailureContext): StreamHandle {
  void modelId;
  const vis = failure(code, ids, ctx);
  const thrown = hostVisibleStreamError(vis);
  const stream = replayStream<StreamPart>();
  stream.push({ type: "error", error: vis });
  stream.close();
  notify(onTerminal, {
    terminalClass: "error",
    toolCallCount: 0,
    rejected: true,
    errorCode: vis.code,
    ...(vis.failureId ? { failureId: vis.failureId } : {}),
    ...(vis.stage ? { stage: vis.stage } : {}),
    ...(ctx?.invocationId ? { invocationId: ctx.invocationId } : {}),
  });
  return { fullStream: stream.iterable, ...settleRejected(thrown) };
}
/** Production validates the entire model batch before handing any executable
 * material to the native Host. This is not a new tool executor or retry loop. */
export const MANAGED_TOOL_POLICY = "validated-batch" as const;
export type StreamingSessionConfig = {
  modelId: string; vision: boolean; parallel: "allow" | "fail-closed" | typeof MANAGED_TOOL_POLICY;
  produce: (request: StreamRequest & { envelope: ModelEnvelope; abortSignal: AbortSignal }) => AsyncIterable<StreamPart> | Promise<AsyncIterable<StreamPart>>;
  usage?: HostUsage;
  providerCalls?: { count: number };
  onTerminal?: (terminal: SessionTerminal) => void;
  onToolCall?: () => void;
  maxParts?: number; maxBytes?: number;
  agentId?: string;
  invocationId?: string;
  visibleStage?: (code: string) => VisibleFailureStage | undefined;
};

/** Eager single producer, bounded replay and independent completion. No observer drives or steals production. */
export function createStreamingPromptSession(config: StreamingSessionConfig): PromptSession {
  // Optional caller/test policy only. Production has no received-event quota.
  const partLimit = Number.isSafeInteger(config.maxParts) && config.maxParts! > 0 ? config.maxParts! : undefined;
  const byteLimit = Number.isSafeInteger(config.maxBytes) && config.maxBytes! > 0 ? Math.min(config.maxBytes!, STREAM_MAX_BYTES) : STREAM_MAX_BYTES;
  return { stream(request = {}) {
    const streamCtx = (stage?: VisibleFailureStage): VisibleFailureContext => ({
      agentId: config.agentId,
      invocationId: typeof request.invocationId === "string" ? request.invocationId : config.invocationId,
      ...(stage ? { stage } : {}),
    });
    const stageFor = (code: string): VisibleFailureStage | undefined => config.visibleStage?.(code);
    let envelope: ModelEnvelope;
    try {
      if (request.envelope && request.messages) throw new EnvelopeError("invalid_envelope");
      envelope = request.envelope ? parseModelEnvelope(request.envelope) : buildHostEnvelope(request.messages ?? []);
      // Keep an explicit single-tool policy for consumers that require one.
      // Production prefers single-call generation by default, but that preference
      // is not the native Host's execution capability or a batch-size quota.
      if (config.parallel === "fail-closed" || (config.parallel === MANAGED_TOOL_POLICY && envelope.options.parallelToolCalls === undefined)) {
        envelope = parseModelEnvelope({ ...envelope, options: { ...envelope.options, parallelToolCalls: false } });
      }
    } catch (error) {
      const code = error instanceof EnvelopeError ? error.code : "invalid_envelope";
      return visibleFailureHandle(config.modelId, code, undefined, config.onTerminal, streamCtx(stageFor(code)));
    }
    if (!request.abortSignal?.aborted && envelopeHasImage(envelope) && !config.vision) {
      return visibleFailureHandle(config.modelId, "unsupported_image", undefined, config.onTerminal, streamCtx(stageFor("unsupported_image")));
    }
    const replay = replayStream<StreamPart>(config.parallel === MANAGED_TOOL_POLICY ? {
      read: part => part.type === "text-delta" || part.type === "reasoning" ? { key: part.type, text: part.textDelta } : undefined,
      withText: (part, text) => {
        if (part.type !== "text-delta" && part.type !== "reasoning") return part;
        const projected = { ...part, textDelta: text, text };
        return projected;
      },
    } : undefined);
    const outputBudget = new StreamOutputBudget(byteLimit);
    const evidence = new StreamEvidence();
    evidence.setCount("declaredTools", envelope.tools.length);
    const controller = new AbortController();
    let complete = false;
    let resolveResponse!: (value: HostResponse) => void;
    let rejectResponse!: (reason: Error) => void;
    let resolveUsage!: (value: HostUsage) => void;
    let rejectUsage!: (reason: Error) => void;
    const response = new Promise<HostResponse>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const usage = new Promise<HostUsage>((resolve, reject) => { resolveUsage = resolve; rejectUsage = reject; });
    void response.catch(() => undefined);
    void usage.catch(() => undefined);
    const content: Exclude<SessionMessage["content"], string> = [];
    const calls = new Map<string, ToolCall>();
    const pending = new Map<string, { name: string; text: ChunkedText }>();
    const held: ToolCall[] = [];
    const heldToolParts: StreamPart[] = [];
    const lastHeldDelta = new Map<string, number>();
    const holdPart = (part: StreamPart) => {
      if (part.type !== "tool-call-delta") { heldToolParts.push(part); return; }
      for (let offset = 0; offset < part.argsTextDelta.length;) {
        const index = lastHeldDelta.get(part.toolCallId), prior = index === undefined ? undefined : heldToolParts[index];
        const room = prior?.type === "tool-call-delta" ? STREAM_STORAGE_CHARS - prior.argsTextDelta.length : 0;
        const take = Math.min(room || STREAM_STORAGE_CHARS, part.argsTextDelta.length - offset);
        const text = part.argsTextDelta.slice(offset, offset + take);
        if (room && prior?.type === "tool-call-delta") prior.argsTextDelta += text;
        else { lastHeldDelta.set(part.toolCallId, heldToolParts.length); heldToolParts.push({ ...part, argsTextDelta: text }); }
        offset += take;
      }
    };
    const storage = () => {
      const saved = replay.storage();
      // Conservative representation accounting; duplicates of semantic payload
      // (text state, parameter assembly, complete args) are included explicitly.
      const estimated = saved.estimatedBytes + outputBudget.used * 6 + heldToolParts.length * 256 + content.length * 192;
      evidence.setCount("replayRecords", saved.records); evidence.setCount("heldToolRecords", heldToolParts.length);
      evidence.setCount("retainedStorageBytes", estimated);
      return estimated;
    };
    // Completion order is not model order when argument streams interleave.
    const toolOrder = new Map<string, number>();
    let bytes = 0;
    let parts = 0;
    let iterator: AsyncIterator<StreamPart> | undefined;
    const validatedBatch = config.parallel === MANAGED_TOOL_POLICY;
    const singleToolOnly = config.parallel === "fail-closed" || (!validatedBatch && envelope.options.parallelToolCalls === false);
    const holdTools = validatedBatch || singleToolOnly;
    evidence.toolPolicy(validatedBatch ? "validated-batch" : singleToolOnly ? "single-tool" : "incremental", envelope.options.parallelToolCalls);
    if (holdTools) evidence.toolBatch("held");
    const declaredTools = new Set(envelope.tools.map((tool) => tool.name));
    const observeTool = () => { try { config.onToolCall?.(); } catch { /* diagnostics do not execute tools */ } };
    const pushText = (type: "text" | "reasoning", text: string) => {
      const previous = content.at(-1);
      if (previous?.type === type) previous.text += text;
      else content.push({ type, text });
    };
    const finish = (reason: FinishReason, error?: VisibleFailure, rawUsage?: HostUsage) => {
      if (complete) return;
      // Transport completion is not a main answer. The explicitly qualified,
      // inference-only memory/episode consumers accept complete blank text as
      // no changes; do not turn that native no-op into a post-delivery failure.
      // Unqualified/main blank output still retains managed failure provenance.
      // Host display only consumes SendToUser. A managed model that stops with
      // leftover assistant text must be reshaped into that Host tool, not treated
      // as a successful silent turn. Aux STEPs without the tool keep text internal.
      if (reason === "stop" && calls.size === 0 && held.length === 0) {
        const delivered = content.filter((part): part is SessionTextContentPart => part.type === "text").map((part) => part.text).join("");
        if (!delivered.trim()) {
          const aux = grokboxAuxFrom({ grokboxAux: request.aux });
          if (aux && aux.parent.modelId === config.modelId && envelope.tools.length === 0) {
            evidence.setCount("auxiliaryEmptyCompletions", 1);
          } else {
            reason = "error";
            error = failure("invalid_stream", undefined, { ...streamCtx("normalize"), diagnostic: { normalizeCause: "empty_output", rejectSite: "host_terminal", stream: evidence.snapshot() } });
          }
        } else if (declaredTools.has("SendToUser")) {
          const endTurn = declaredTextEndTurn(envelope.tools.find(tool => tool.name === "SendToUser")!);
          const call: ToolCall = {
            type: "tool-call",
            toolCallId: randomUUID(),
            toolName: "SendToUser",
            args: { type: "text", content: delivered, ...(endTurn ? { end_turn: true } : {}) },
          };
          // The text delivery is a projection, not a replacement for the model's
          // ordered assistant history (including native inline reasoning).
          evidence.setCount("syntheticDeliveries", 1);
          if (endTurn) evidence.setCount("syntheticFinalDeliveries", 1);
          held.push(call);
          heldToolParts.push(call);
        }
      }
      if (reason === "stop") {
        // Reserve the replay copies before releasing the first executable part.
        // A finalization overrun cannot leave a partially admitted tool batch.
        const projectedStorage = storage() + heldToolParts.reduce((sum, part) => sum + 192 + 2 * JSON.stringify(part).length, 0) + held.length * 192;
        if (projectedStorage > STREAM_RETAINED_BYTES) {
          reason = "error";
          error = failure("stream_limit", undefined, { ...streamCtx("normalize"), diagnostic: { normalizeCause: "stream_budget", rejectSite: "host_terminal", budget: { layer: "host", metric: "retained_bytes", limit: STREAM_RETAINED_BYTES, measured: projectedStorage } } });
        }
      }
      complete = true;
      request.abortSignal?.removeEventListener("abort", abort);
      if (reason === "stop") {
        // A legal multi-call batch is one assistant response. Preserve every ID,
        // start/delta/complete protocol, and first-seen call order in both views.
        // Host still owns approvals, actual execution/concurrency and results.
        // Publishing several descriptors here does NOT claim serial execution.
        if (validatedBatch) {
          const rank = (part: StreamPart) => "toolCallId" in part ? toolOrder.get(part.toolCallId) ?? toolOrder.size : toolOrder.size;
          held.sort((a, b) => rank(a) - rank(b));
          heldToolParts.sort((a, b) => rank(a) - rank(b));
        }
        for (const part of heldToolParts) replay.push(part);
        for (const call of held) { content.push(call); observeTool(); }
      }
      const toolCalls = content.filter((part): part is ToolCall => part.type === "tool-call");
      evidence.setCount("toolsStarted", toolOrder.size);
      evidence.setCount("toolsCompleted", calls.size);
      evidence.setCount("openTools", pending.size);
      evidence.setCount("hostToolsReleased", toolCalls.length);
      if (holdTools) evidence.toolBatch(reason === "stop" ? "released" : "discarded");
      evidence.setCount("semanticOutputBytes", outputBudget.used); storage();
      const terminalStream = evidence.snapshot();
      if (error) error.diagnostic = { ...error.diagnostic, stream: terminalStream };
      notify(config.onTerminal, {
        terminalClass: reason,
        toolCallCount: toolCalls.length,
        purpose: request.aux?.purpose ?? "main",
        ...(request.aux ? { parentStepId: request.aux.parent.stepId } : {}),
        diagnostic: error ? { ...error.diagnostic, stream: terminalStream } : { stream: { ...terminalStream, tail: [] } },
        ...(error?.failureSummary ? { failureSummary: error.failureSummary } : {}),
        ...(error?.presentation ? { presentation: error.presentation } : {}),
        ...(typeof request.invocationId === "string" ? { invocationId: request.invocationId } : {}),
        ...(error ? { failureId: error.failureId, errorCode: error.code, ...(error.stage ? { stage: error.stage } : {}), rejected: true } : {}),
      });
      if (reason === "error" && error) {
        const thrown = hostVisibleStreamError(error);
        replay.push({ type: "error", error });
        replay.close();
        rejectResponse(thrown);
        rejectUsage(thrown);
        controller.abort();
        try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* producer cleanup is best effort */ }
        return;
      }
      const finishReason = reason === "stop" && toolCalls.length ? "tool-calls" : reason;
      const textOnly = content.every((part) => part.type === "text");
      const message: SessionMessage = { role: "assistant", content: textOnly ? content.map((part) => (part as SessionTextContentPart).text).join("") : structuredClone(content) };
      const result: HostResponse = { modelId: config.modelId, finishReason, messages: [message] };
      const normalized = normalizeHostUsage(rawUsage ?? (reason === "stop" ? config.usage : undefined) ?? ZERO_USAGE);
      replay.push({ type: "finish", reason, finishReason, response: result, usage: normalized });
      replay.close();
      resolveResponse(result); resolveUsage(normalized);
      controller.abort();
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* producer cleanup is best effort */ }
    };
    const abort = () => finish("abort");
    const failStream = (code: string, stage?: VisibleFailureStage, detail?: StreamDiagnostic, summary?: FailureSummary) => {
      evidence.setCount("openTools", pending.size); evidence.setCount("toolsCompleted", calls.size);
      evidence.setCount("hostToolsReleased", content.filter(p => p.type === "tool-call").length);
      const defaults: StreamDiagnostic = detail !== undefined ? {} : code === "invalid_stream" ? { normalizeCause: "invalid_event_shape", rejectSite: "host_event" }
        : code === "parallel_tools" ? { normalizeCause: "parallel_tools", rejectSite: "host_tool" }
        : code === "stream_limit" ? { normalizeCause: "stream_budget", rejectSite: "stream_budget" } : {};
      finish("error", failure(code, [...new Set([...calls.keys(), ...pending.keys()])], {
        ...streamCtx(stage ?? stageFor(code)), diagnostic: { ...defaults, ...detail, stream: evidence.snapshot() },
        ...(summary ? { failureSummary: summary, receivedOutput: toolOrder.size > 0 || content.some(p => (p.type === "text" || p.type === "reasoning") && p.text.length > 0) } : {}),
      }));
    };
    const validId = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x09\x0b\x0c\x0e-\x1f]/.test(value);
    const accept = (raw: StreamPart) => {
      if (complete) return;
      const part = cloneJson(raw) as unknown as StreamPart;
      evidence.note("host", part.type); evidence.increment("hostEvents"); evidence.first("hostFirstEventMs");
      ++parts;
      const partBytes = Buffer.byteLength(JSON.stringify(part)); bytes += partBytes; evidence.increment("hostBytes", partBytes);
      if (partLimit !== undefined && parts > partLimit) return failStream("stream_limit", "normalize", { normalizeCause: "stream_budget", rejectSite: "host_event", budget: { layer: "host", metric: "event_count", limit: partLimit, measured: parts } });
      const measured = budgetEvent(part);
      if (measured && !outputBudget.add(measured)) return failStream("stream_limit", "normalize", { normalizeCause: "stream_budget", rejectSite: "host_event", budget: { layer: "host", metric: "output_bytes", limit: byteLimit, measured: outputBudget.used } });
      evidence.setCount("semanticOutputBytes", outputBudget.used);
      if (part.type === "finish") {
        if (!["stop", "error", "abort"].includes(part.reason)) return failStream("invalid_stream", "normalize", { normalizeCause: "invalid_terminal", rejectSite: "host_terminal" });
        if (pending.size) return failStream("invalid_stream", "normalize", { normalizeCause: "open_tools_at_finish", rejectSite: "host_terminal" });
        if (part.reason === "stop" && !measuredHostUsage(part.usage) && !measuredHostUsage(config.usage)) {
          return failStream("model_error", "provider", { normalizeCause: "invalid_usage", rejectSite: "host_terminal" });
        }
        finish(part.reason, part.reason === "error" ? failure("model_error", undefined, streamCtx(stageFor("model_error"))) : undefined, part.usage); return;
      }
      if (part.type === "error") {
        const vis = part.error as { userVisible?: unknown; code?: unknown; stage?: VisibleFailureStage };
        if (vis && vis.userVisible === true && typeof vis.code === "string") {
          return failStream(vis.code, vis.stage ?? stageFor(vis.code));
        }
        return failStream("model_error");
      }
      if (part.type === "text-delta" || part.type === "reasoning") {
        if (typeof part.textDelta !== "string") return failStream("invalid_stream");
        pushText(part.type === "text-delta" ? "text" : "reasoning", part.textDelta);
        replay.push({ type: part.type, textDelta: part.textDelta, text: part.textDelta } as StreamPart); return;
      }
      if (part.type !== "tool-call" && part.type !== "tool-call-delta" && part.type !== "tool-call-streaming-start") return failStream("invalid_stream");
      if (!validId(part.toolCallId) || !validId(part.toolName)) return failStream("invalid_stream", "normalize", { normalizeCause: "tool_identity_conflict", rejectSite: "host_tool" });
      if (!declaredTools.has(part.toolName)) return failStream("invalid_stream", "normalize", { normalizeCause: "undeclared_tool", rejectSite: "host_tool", declaredToolMatch: false });
      if (!toolOrder.has(part.toolCallId)) toolOrder.set(part.toolCallId, toolOrder.size);
      if (part.type !== "tool-call") {
        const current = pending.get(part.toolCallId);
        if (calls.has(part.toolCallId) || (current && (part.type === "tool-call-streaming-start" || current.name !== part.toolName))) return failStream("invalid_stream", "normalize", { normalizeCause: "tool_identity_conflict", rejectSite: "host_tool" });
        if (part.type === "tool-call-delta" && typeof part.argsTextDelta !== "string") return failStream("invalid_stream");
        const text = current?.text ?? new ChunkedText();
        if (part.type === "tool-call-delta") text.append(part.argsTextDelta);
        pending.set(part.toolCallId, { name: part.toolName, text });
        // Native Host consumers may execute incrementally from argument deltas.
        // A held response must pass the complete structural/finish gate before
        // exposing ANY executable material, not just tool-complete.
        const projected: StreamPart = part.type === "tool-call-streaming-start"
          ? { type: part.type, toolCallId: part.toolCallId, toolName: part.toolName }
          : { type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, argsTextDelta: part.argsTextDelta };
        if (holdTools) holdPart(projected);
        else replay.push(projected);
        return;
      }
      const call: ToolCall = { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: cloneJson(part.args) };
      const assembling = pending.get(call.toolCallId);
      if (assembling?.name && assembling.name !== call.toolName) return failStream("invalid_stream", "normalize", { normalizeCause: "tool_identity_conflict", rejectSite: "host_tool" });
      if (assembling && assembling.text.chars > 0) {
        let decoded: unknown;
        try { decoded = JSON.parse(assembling.text.text()); } catch { return failStream("invalid_stream", "normalize", { normalizeCause: "tool_arguments_invalid", rejectSite: "host_tool" }); }
        if (!isDeepStrictEqual(decoded, call.args)) return failStream("invalid_stream", "normalize", { normalizeCause: "tool_arguments_mismatch", rejectSite: "host_tool" });
      }
      pending.delete(call.toolCallId);
      const prior = calls.get(call.toolCallId);
      if (prior) { if (!isDeepStrictEqual(prior, call)) failStream("invalid_stream", "normalize", { normalizeCause: "tool_identity_conflict", rejectSite: "host_tool" }); return; }
      calls.set(call.toolCallId, call);
      if (singleToolOnly && calls.size > 1) return failStream("parallel_tools", "normalize");
      if (holdTools) { held.push(call); heldToolParts.push(call); }
      else { content.push(call); replay.push(call); observeTool(); }
    };
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    if (request.abortSignal?.aborted) abort();
    else {
      if (config.providerCalls) config.providerCalls.count += 1;
      void (async () => {
        try {
          const source = await config.produce({ ...request, envelope, abortSignal: controller.signal });
          iterator = source[Symbol.asyncIterator]();
          if (complete) { void Promise.resolve(iterator.return?.()).catch(() => {}); return; }
          while (!complete) {
            const next = await iterator.next();
            if (complete) break;
            if (next.done) { failStream("invalid_stream", "normalize", { normalizeCause: "missing_finish", rejectSite: "host_terminal" }); break; }
            try {
              accept(next.value);
              const retained = storage();
              if (!complete && retained > STREAM_RETAINED_BYTES) failStream("stream_limit", "normalize", { normalizeCause: "stream_budget", rejectSite: "host_event", budget: { layer: "host", metric: "retained_bytes", limit: STREAM_RETAINED_BYTES, measured: retained } });
            } catch { failStream("invalid_stream"); }
          }
        } catch (error) {
          if (!complete) {
            if (error instanceof VisibleStreamError) failStream(error.code, error.stage, streamFailureDiagnostic(error), failureSummaryOf(error));
            else failStream("model_error");
          }
        }
      })();
    }
    return { fullStream: replay.iterable, response, usage };
  } };
}

export type ManagedSessionConfig = Omit<StreamingSessionConfig, "produce"> & { parts: StreamPart[]; transcriptWrites?: unknown[] };
export function createManagedPromptSession(config: ManagedSessionConfig): PromptSession {
  const session = createStreamingPromptSession({
    ...config,
    produce: () => ({ async *[Symbol.asyncIterator]() { for (const part of config.parts) yield part; } }),
  });
  return { stream(request = {}) {
    const calls = config.parts.filter((part): part is Extract<StreamPart, { type: "tool-call" }> => part.type === "tool-call");
    if (!request.abortSignal?.aborted && config.parallel === "fail-closed" && new Set(calls.map((call) => call.toolCallId)).size > 1) {
      return visibleFailureHandle(config.modelId, "parallel_tools", calls.map((call) => call.toolCallId), config.onTerminal, {
        agentId: config.agentId, invocationId: request.invocationId ?? config.invocationId, stage: "admit",
      });
    }
    return session.stream(request);
  } };
}
