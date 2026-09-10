import { isDeepStrictEqual } from "node:util";
import { cloneJson, envelopeHasImage, EnvelopeError, parseModelEnvelope,
  type EnvelopeErrorCode, type ModelEnvelope, type PromptContentPart, type PromptMessage, type ToolCall } from "@grokbox/runtime-kernel/contract";
import { buildHostEnvelope, cloneHostExecutorWindow } from "./context-codec.ts";
import { replayStream } from "./replay-stream.ts";
import { combineAbortSignals } from "./abort-signals.ts";
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
  /** Internal compatibility only; Host projection uses tool-call content blocks. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
};
export type HostUsage = {
  promptTokens: number; completionTokens: number; totalTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number;
};
export type VisibleFailureStage = "admit" | "provider" | "normalize";
export type VisibleFailure = {
  userVisible: true;
  code: string;
  message: string;
  toolCallIds?: string[];
  agentId?: string;
  invocationId?: string;
  stage?: VisibleFailureStage;
};
export type VisibleFailureContext = {
  agentId?: string;
  invocationId?: string;
  stage?: VisibleFailureStage;
};
export type HostResponse = { modelId: string; messages: SessionMessage[]; finishReason?: HostFinishReason; error?: VisibleFailure };
export type StreamHandle = { fullStream: AsyncIterable<StreamPart>; response: Promise<HostResponse>; usage: Promise<HostUsage> };
export type StreamRequest = { messages?: PromptMessage[]; envelope?: ModelEnvelope; invocationId?: string; abortSignal?: AbortSignal };
export type PromptSession = { stream: (request?: StreamRequest) => StreamHandle };
export type ExtendedUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number };
export type HostStreamResult = StreamHandle & {
  extendedUsage: Promise<ExtendedUsage>; providerMetadata: Promise<Record<string, unknown>>; invocationId: Promise<unknown>;
};
export class InvalidHostStateError extends EnvelopeError {
  readonly name = "InvalidHostStateError";
  constructor(code: EnvelopeErrorCode = "invalid_envelope") {
    super(code);
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
    for (const call of message.toolCalls ?? []) {
      if (!content.some((part) => part.type === "tool-call" && part.toolCallId === call.id)) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, args: cloneJson(call.args) });
      }
    }
    return { role: "assistant" as const, content };
  });
  return { modelId: typeof record.modelId === "string" ? record.modelId : "", messages: messages.length ? messages : [{ role: "assistant", content: [] }],
    ...(record.finishReason ? { finishReason: record.finishReason } : {}), ...(record.error ? { error: structuredClone(record.error) } : {}) };
}
/** Error Host `classifyError2` wraps as RetriableError → runTurn catch → official tray. Not assistant text. */
export function hostVisibleStreamError(failure: VisibleFailure): Error {
  const err = new Error(failure.message);
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
  input: { invocationId?: string; requireStepId?: boolean; contextWindowTokens?: number; reject?: (code: string, detail?: HostStreamRejectDetail) => StreamHandle } = {}): HostPromptSession {
  const notified = new Set<string>();
  const createExecutor = (state?: unknown): HostPromptExecutor => {
    let messages: ReturnType<typeof cloneHostExecutorWindow> = [];
    let invalidCode: EnvelopeErrorCode | undefined;
    if (state !== undefined) {
      try { messages = cloneHostExecutorWindow(state); }
      catch (error) { invalidCode = error instanceof EnvelopeError ? error.code : "invalid_envelope"; }
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
        }
        return executor;
      },
      getMessages: read,
      getState: read,
      clearMessages() { messages = []; invalidCode = undefined; },
      stream(ctx, invocationId, tools, options) {
        const requestId = input.requireStepId ? invocationId : (invocationId ?? input.invocationId);
        let cancellation: ReturnType<typeof combineAbortSignals> | undefined;
        try {
          if (input.requireStepId) {
            if (requestId === undefined) throw new EnvelopeError("invalid_envelope", "missing-step-id");
            if (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\x00-\x1f]/.test(requestId)) {
              throw new EnvelopeError("invalid_envelope", "invalid-step-id");
            }
          } else if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\x00-\x1f]/.test(requestId))) {
            throw new EnvelopeError("invalid_envelope");
          }
          cancellation = abortSignalFrom(ctx, options);
          const signal = cancellation.signal;
          if (invalidCode && !signal?.aborted) throw new EnvelopeError(invalidCode);
          const envelope = signal?.aborted ? buildHostEnvelope([]) : buildHostEnvelope(messages, tools, options);
          const handle = session.stream({ envelope, abortSignal: signal, ...(typeof requestId === "string" ? { invocationId: requestId } : {}) });
          void handle.response.then(cancellation.dispose, cancellation.dispose);
          if (typeof requestId === "string" && !notified.has(requestId)) {
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
export const STREAM_MAX_PARTS = 4096;
export const STREAM_MAX_BYTES = 1024 * 1024;
const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_image: "Configured model does not accept images. No model request was sent.",
  parallel_tools: "Parallel tool calls are not supported. Rejected calls were not executed.",
  invalid_envelope: "The model request could not be converted safely. No model request was sent.",
  unsupported_content: "The message contains unsupported content. No model request was sent.",
  invalid_tools: "Tool definitions could not be converted safely. No model request was sent.",
  unsupported_options: "The model request contains unsupported options. No model request was sent.",
  envelope_too_large: "The model request exceeds the supported envelope limit. No model request was sent.",
  stream_limit: "The model stream exceeded its safety limit and was stopped.",
  invalid_stream: "The model returned an invalid stream. The request was stopped without retry.",
  invocation_conflict: "This invocation was already used with different inputs. It was not dispatched again.",
  model_error: "The configured model request failed. No fallback model was used.",
};
const VISIBLE_STAGES = new Set<VisibleFailureStage>(["admit", "provider", "normalize"]);
function boundedVisible(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : undefined;
}
function visibleContext(ctx?: VisibleFailureContext): VisibleFailureContext {
  const agentId = boundedVisible(ctx?.agentId);
  const invocationId = boundedVisible(ctx?.invocationId);
  const stage = ctx?.stage && VISIBLE_STAGES.has(ctx.stage) ? ctx.stage : undefined;
  return { ...(agentId ? { agentId } : {}), ...(invocationId ? { invocationId } : {}), ...(stage ? { stage } : {}) };
}
function failure(code: string, ids?: string[], ctx?: VisibleFailureContext): VisibleFailure {
  const resolved = Object.hasOwn(FAILURE_MESSAGES, code) ? code : "model_error";
  const extra = visibleContext(ctx);
  const bits = [
    extra.agentId ? `agentId=${extra.agentId}` : undefined,
    extra.invocationId ? `invocationId=${extra.invocationId}` : undefined,
    extra.stage ? `stage=${extra.stage}` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  const message = bits.length ? `${FAILURE_MESSAGES[resolved] ?? FAILURE_MESSAGES.model_error!} (${bits.join(" ")})` : FAILURE_MESSAGES[resolved] ?? FAILURE_MESSAGES.model_error!;
  const error: VisibleFailure = {
    userVisible: true, code: resolved, message,
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
    super(message ?? code);
    this.code = Object.hasOwn(FAILURE_MESSAGES, code) ? code : "model_error";
    this.stage = VISIBLE_STAGES.has(stage) ? stage : "provider";
  }
}
export type SessionTerminal = {
  terminalClass: FinishReason; toolCallCount: number; rejected?: boolean; errorCode?: string; stage?: VisibleFailureStage; invocationId?: string;
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
    ...(vis.stage ? { stage: vis.stage } : {}),
    ...(ctx?.invocationId ? { invocationId: ctx.invocationId } : {}),
  });
  return { fullStream: stream.iterable, ...settleRejected(thrown) };
}
export type StreamingSessionConfig = {
  modelId: string; vision: boolean; parallel: "allow" | "fail-closed";
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
  const partLimit = Number.isSafeInteger(config.maxParts) && config.maxParts! > 0 ? Math.min(config.maxParts!, STREAM_MAX_PARTS) : STREAM_MAX_PARTS;
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
    } catch (error) {
      const code = error instanceof EnvelopeError ? error.code : "invalid_envelope";
      return visibleFailureHandle(config.modelId, code, undefined, config.onTerminal, streamCtx(stageFor(code)));
    }
    if (!request.abortSignal?.aborted && envelopeHasImage(envelope) && !config.vision) {
      return visibleFailureHandle(config.modelId, "unsupported_image", undefined, config.onTerminal, streamCtx(stageFor("unsupported_image")));
    }
    const replay = replayStream<StreamPart>();
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
    const pending = new Map<string, { name: string; text: string }>();
    const held: ToolCall[] = [];
    let bytes = 0;
    let parts = 0;
    let iterator: AsyncIterator<StreamPart> | undefined;
    const serial = config.parallel === "fail-closed" || envelope.options.parallelToolCalls === false;
    const declaredTools = new Set(envelope.tools.map((tool) => tool.name));
    const observeTool = () => { try { config.onToolCall?.(); } catch { /* diagnostics do not execute tools */ } };
    const pushText = (type: "text" | "reasoning", text: string) => {
      const previous = content.at(-1);
      if (previous?.type === type) previous.text += text;
      else content.push({ type, text });
    };
    const finish = (reason: FinishReason, error?: VisibleFailure, rawUsage?: HostUsage) => {
      if (complete) return;
      complete = true;
      request.abortSignal?.removeEventListener("abort", abort);
      if (reason === "stop") for (const call of held) { replay.push(call); content.push(call); observeTool(); }
      const toolCalls = content.filter((part): part is ToolCall => part.type === "tool-call");
      notify(config.onTerminal, {
        terminalClass: reason,
        toolCallCount: toolCalls.length,
        ...(typeof request.invocationId === "string" ? { invocationId: request.invocationId } : {}),
        ...(error ? { errorCode: error.code, ...(error.stage ? { stage: error.stage } : {}), rejected: true } : {}),
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
      if (toolCalls.length) message.toolCalls = toolCalls.map((call) => ({ id: call.toolCallId, name: call.toolName, args: structuredClone(call.args) }));
      const result: HostResponse = { modelId: config.modelId, finishReason, messages: [message] };
      const normalized = normalizeHostUsage(rawUsage ?? (reason === "stop" ? config.usage : undefined) ?? ZERO_USAGE);
      replay.push({ type: "finish", reason, finishReason, response: result, usage: normalized });
      replay.close();
      resolveResponse(result); resolveUsage(normalized);
      controller.abort();
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* producer cleanup is best effort */ }
    };
    const abort = () => finish("abort");
    const failStream = (code: string, stage?: VisibleFailureStage) => finish("error", failure(code, [...new Set([...calls.keys(), ...pending.keys()])],
      streamCtx(stage ?? stageFor(code))));
    const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
    const accept = (raw: StreamPart) => {
      if (complete) return;
      const part = cloneJson(raw) as unknown as StreamPart;
      if (++parts > partLimit) return failStream("stream_limit");
      bytes += Buffer.byteLength(JSON.stringify(part));
      if (bytes > byteLimit) return failStream("stream_limit");
      if (part.type === "finish") {
        if (!["stop", "error", "abort"].includes(part.reason) || pending.size) return failStream("invalid_stream");
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
      if (!validId(part.toolCallId) || !validId(part.toolName) || !declaredTools.has(part.toolName)) return failStream("invalid_stream");
      if (part.type !== "tool-call") {
        const current = pending.get(part.toolCallId);
        if (calls.has(part.toolCallId) || (current && (part.type === "tool-call-streaming-start" || current.name !== part.toolName))) return failStream("invalid_stream");
        if (part.type === "tool-call-delta" && typeof part.argsTextDelta !== "string") return failStream("invalid_stream");
        pending.set(part.toolCallId, { name: part.toolName, text: (current?.text ?? "") + (part.type === "tool-call-delta" ? part.argsTextDelta : "") });
        replay.push(part.type === "tool-call-streaming-start"
          ? { type: part.type, toolCallId: part.toolCallId, toolName: part.toolName }
          : { type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, argsTextDelta: part.argsTextDelta }); return;
      }
      const call: ToolCall = { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: cloneJson(part.args) };
      const assembling = pending.get(call.toolCallId);
      if (assembling && (assembling.name !== call.toolName || (assembling.text && !isDeepStrictEqual(JSON.parse(assembling.text), call.args)))) return failStream("invalid_stream");
      pending.delete(call.toolCallId);
      const prior = calls.get(call.toolCallId);
      if (prior) { if (!isDeepStrictEqual(prior, call)) failStream("invalid_stream"); return; }
      calls.set(call.toolCallId, call);
      if (serial && calls.size > 1) return failStream("parallel_tools");
      if (serial) held.push(call);
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
            if (next.done) { failStream("invalid_stream"); break; }
            try { accept(next.value); } catch { failStream("invalid_stream"); }
          }
        } catch (error) {
          if (!complete) {
            if (error instanceof VisibleStreamError) failStream(error.code, error.stage);
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
  const session = createStreamingPromptSession({ ...config, usage: config.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    produce: () => ({ async *[Symbol.asyncIterator]() { for (const part of config.parts) yield part; } }) });
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
