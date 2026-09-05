export type FinishReason = "stop" | "error" | "abort";

export type StreamPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "finish";
      reason: FinishReason;
      finishReason?: FinishReason;
      usage?: HostUsage;
      response?: HostResponse;
    };

export type SessionTextContentPart = { type: "text"; text: string };

export type SessionMessage = {
  role: "assistant";
  content: string | SessionTextContentPart[];
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
};

export type HostUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type HostResponse = {
  modelId: string;
  messages: SessionMessage[];
};

export type StreamHandle = {
  fullStream: AsyncIterable<StreamPart>;
  response: Promise<HostResponse>;
  usage: Promise<HostUsage>;
};

export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; mimeType?: string };

export type PromptMessage = {
  role: "user" | "assistant" | "system";
  content: string | PromptContentPart[];
};

export type StreamRequest = {
  messages?: PromptMessage[];
  abortSignal?: AbortSignal;
};

export type PromptSession = {
  stream: (request?: StreamRequest) => StreamHandle;
};

export type ExtendedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  maxTokens: number;
};

export type HostStreamResult = StreamHandle & {
  extendedUsage: Promise<ExtendedUsage>;
  providerMetadata: Promise<Record<string, unknown>>;
  invocationId: Promise<unknown>;
};

export type HostPromptExecutor = {
  appendMessages: (messages?: unknown) => HostPromptExecutor;
  getMessages: () => unknown[];
  getState: () => unknown[];
  clearMessages: () => void;
  stream: (
    ctx?: unknown,
    invocationId?: unknown,
    tools?: unknown,
    options?: unknown,
  ) => HostStreamResult;
};

export type HostPromptSession = {
  getModelId: () => string;
  getExecutor: (state?: unknown) => HostPromptExecutor;
  getExecutorWithoutResolvedModelTracking: (state?: unknown) => HostPromptExecutor;
};

export function isHostPromptSession(value: unknown): value is HostPromptSession {
  if (value === null || typeof value !== "object") return false;
  const session = value as Partial<HostPromptSession>;
  return (
    typeof session.getModelId === "function" &&
    typeof session.getExecutor === "function" &&
    typeof session.getExecutorWithoutResolvedModelTracking === "function"
  );
}

function abortSignalFrom(ctx: unknown, options: unknown): AbortSignal | undefined {
  if (options !== null && typeof options === "object") {
    const signal = (options as { abortSignal?: unknown }).abortSignal;
    if (signal instanceof AbortSignal) return signal;
  }
  if (ctx !== null && typeof ctx === "object") {
    const record = ctx as { abortSignal?: unknown; signal?: unknown };
    if (record.abortSignal instanceof AbortSignal) return record.abortSignal;
    if (record.signal instanceof AbortSignal) return record.signal;
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeHostUsage(usage: unknown): HostUsage {
  const u = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const promptTokens = numberOrZero(u.promptTokens ?? u.prompt_tokens ?? u.inputTokens ?? u.input_tokens) || 0;
  const completionTokens =
    numberOrZero(u.completionTokens ?? u.completion_tokens ?? u.outputTokens ?? u.output_tokens) || 0;
  const totalTokens = numberOrZero(u.totalTokens ?? u.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function emptyAssistantMessages(): SessionMessage[] {
  return [{ role: "assistant", content: "" }];
}

export function normalizeHostResponse(value: unknown): HostResponse {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const modelId = typeof record.modelId === "string" ? record.modelId : "";
  const messages = Array.isArray(record.messages)
    ? (record.messages as SessionMessage[]).map((message) => {
        if (typeof message.content !== "string" || message.content.length === 0) return message;
        return { ...message, content: [{ type: "text" as const, text: message.content }] };
      })
    : emptyAssistantMessages();
  return { modelId, messages: messages.length > 0 ? messages : emptyAssistantMessages() };
}

function toExtendedUsage(usage: HostUsage): ExtendedUsage {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 0,
  };
}

function iterableFromParts(parts: readonly StreamPart[]): AsyncIterable<StreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  };
}

export function toHostStreamResult(handle: StreamHandle, invocationId?: unknown): HostStreamResult {
  const usage = handle.usage.then(normalizeHostUsage);
  return {
    fullStream: handle.fullStream,
    response: handle.response.then(normalizeHostResponse),
    usage,
    extendedUsage: usage.then(toExtendedUsage),
    providerMetadata: Promise.resolve({}),
    invocationId: Promise.resolve(invocationId),
  };
}

export function asHostPromptSession(
  session: PromptSession,
  modelId: string,
  onRequestId?: (id: string) => void,
): HostPromptSession {
  let messages: unknown[] = [];
  const executor: HostPromptExecutor = {
    appendMessages(next) {
      const list = Array.isArray(next) ? next : next == null ? [] : [next];
      messages.push(...list);
      return executor;
    },
    getMessages() {
      return [...messages];
    },
    getState() {
      return [...messages];
    },
    clearMessages() {
      messages = [];
    },
    stream(ctx, invocationId, _tools, options) {
      if (typeof onRequestId === "function" && typeof invocationId === "string" && invocationId.length > 0) {
        try {
          onRequestId(invocationId);
        } catch {
          /* Host emit must not break stub stream */
        }
      }
      return toHostStreamResult(session.stream({ abortSignal: abortSignalFrom(ctx, options) }), invocationId);
    },
  };
  const bind = (state?: unknown): HostPromptExecutor => {
    if (Array.isArray(state)) messages = [...state];
    return executor;
  };
  return {
    getModelId: () => modelId,
    getExecutor: bind,
    getExecutorWithoutResolvedModelTracking: bind,
  };
}

export type VisibleFailure = {
  userVisible: true;
  message: string;
  toolCallIds?: string[];
};

export type SessionTerminal = {
  terminalClass: "stop" | "error" | "abort";
  toolCallCount: number;
};

export type ManagedSessionConfig = {
  modelId: string;
  vision: boolean;
  parallel: "allow" | "fail-closed";
  parts: StreamPart[];
  transcriptWrites?: unknown[];
  providerCalls?: { count: number };
  onTerminal?: (terminal: SessionTerminal) => void;
};

function hasImage(request: StreamRequest | undefined): boolean {
  for (const message of request?.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((part) => part.type === "image")) return true;
  }
  return false;
}

function collectToolIds(parts: StreamPart[]): string[] {
  return parts.filter((part): part is Extract<StreamPart, { type: "tool-call" }> => part.type === "tool-call")
    .map((part) => part.toolCallId);
}

function messagesFromParts(parts: StreamPart[]): SessionMessage[] {
  let text = "";
  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
  for (const part of parts) {
    if (part.type === "text-delta") text += part.textDelta;
    if (part.type === "tool-call") toolCalls.push({ id: part.toolCallId, name: part.toolName, args: part.args });
  }
  const message: SessionMessage = { role: "assistant", content: text };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return [message];
}

function withHostFinish(parts: StreamPart[], modelId: string, usage: HostUsage): StreamPart[] {
  const messages = messagesFromParts(parts);
  return parts.map((part) => {
    if (part.type !== "finish") return part;
    return {
      ...part,
      finishReason: part.finishReason ?? part.reason,
      usage: part.usage ?? usage,
      response: part.response ?? { modelId, messages },
    };
  });
}

function settledHandle(
  modelId: string,
  parts: StreamPart[],
  usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
): StreamHandle {
  const normalized = normalizeHostUsage(usage);
  const copy = withHostFinish([...parts], modelId, normalized);
  return {
    fullStream: iterableFromParts(copy),
    response: Promise.resolve({ modelId, messages: messagesFromParts(copy) }),
    usage: Promise.resolve(normalized),
  };
}

function toolCallCountFromParts(parts: StreamPart[]): number {
  return messagesFromParts(parts).reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0);
}

function notifyTerminal(onTerminal: ManagedSessionConfig["onTerminal"], produced: StreamPart[]): void {
  if (!onTerminal) return;
  const finish = [...produced].reverse().find((part) => part.type === "finish");
  const terminalClass = finish && finish.type === "finish" ? finish.reason : undefined;
  if (terminalClass !== "stop" && terminalClass !== "error" && terminalClass !== "abort") return;
  try {
    onTerminal({ terminalClass, toolCallCount: toolCallCountFromParts(produced) });
  } catch {
    /* event emission must not change the Host loop */
  }
}

function failedHandle(
  modelId: string,
  error: VisibleFailure,
  onTerminal?: ManagedSessionConfig["onTerminal"],
): StreamHandle {
  const terminal: StreamPart = { type: "finish", reason: "error" };
  notifyTerminal(onTerminal, [terminal]);
  const message: SessionMessage = { role: "assistant", content: "" };
  if (error.toolCallIds && error.toolCallIds.length > 0) {
    message.toolCalls = error.toolCallIds.map((id) => ({ id, name: "", args: {} }));
  }
  const handle = settledHandle(modelId, [terminal], { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  return {
    ...handle,
    response: Promise.resolve({ modelId, messages: [message] }),
  };
}

export function createManagedPromptSession(config: ManagedSessionConfig): PromptSession {
  if (!config.transcriptWrites) config.transcriptWrites = [];
  if (!config.providerCalls) config.providerCalls = { count: 0 };
  return {
    stream(request = {}) {
      if (hasImage(request) && !config.vision) {
        return failedHandle(
          config.modelId,
          {
            userVisible: true,
            message: "Configured model does not accept images.",
          },
          config.onTerminal,
        );
      }

      const toolIds = collectToolIds(config.parts);
      if (toolIds.length > 1 && config.parallel === "fail-closed") {
        return failedHandle(
          config.modelId,
          {
            userVisible: true,
            message: "Parallel tool calls are not supported by the configured model.",
            toolCallIds: toolIds,
          },
          config.onTerminal,
        );
      }

      config.providerCalls!.count += 1;
      const produced: StreamPart[] = [];
      let terminal: StreamPart | undefined;
      for (const part of config.parts) {
        if (request.abortSignal?.aborted) {
          terminal = { type: "finish", reason: "abort" };
          break;
        }
        if (terminal) break;
        produced.push(part);
        if (part.type === "finish") terminal = part;
      }
      if (!terminal) {
        terminal = { type: "finish", reason: request.abortSignal?.aborted ? "abort" : "stop" };
      }
      if (produced.at(-1)?.type !== "finish") produced.push(terminal);
      notifyTerminal(config.onTerminal, produced);
      return settledHandle(config.modelId, produced);
    },
  };
}
