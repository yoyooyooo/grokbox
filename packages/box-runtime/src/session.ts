export type StreamPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "finish"; reason: "stop" | "error" | "abort" };

export type SessionMessage = {
  role: "assistant";
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
};

export type StreamHandle = {
  fullStream: AsyncIterable<StreamPart>;
  response: Promise<{ modelId: string; messages: SessionMessage[] }>;
  usage: Promise<{ promptTokens: number; completionTokens: number }>;
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
};

export type HostStreamResult = StreamHandle & {
  extendedUsage: Promise<ExtendedUsage>;
};

export type HostPromptExecutor = {
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

export function toHostStreamResult(handle: StreamHandle): HostStreamResult {
  return {
    fullStream: handle.fullStream,
    response: handle.response,
    usage: handle.usage,
    extendedUsage: handle.usage.then((usage) => ({
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })),
  };
}

export function asHostPromptSession(session: PromptSession, modelId: string): HostPromptSession {
  const executor: HostPromptExecutor = {
    stream(ctx, _invocationId, _tools, options) {
      return toHostStreamResult(session.stream({ abortSignal: abortSignalFrom(ctx, options) }));
    },
  };
  return {
    getModelId: () => modelId,
    getExecutor: () => executor,
    getExecutorWithoutResolvedModelTracking: () => executor,
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
  const message: SessionMessage = { role: "assistant" };
  if (text.length > 0) message.content = text;
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return [message];
}

function settledHandle(
  modelId: string,
  parts: StreamPart[],
  usage = { promptTokens: 1, completionTokens: 1 },
): StreamHandle {
  const copy = [...parts];
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        for (const part of copy) yield part;
      },
    },
    response: Promise.resolve({ modelId, messages: messagesFromParts(copy) }),
    usage: Promise.resolve(usage),
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

function failedHandle(error: VisibleFailure, onTerminal?: ManagedSessionConfig["onTerminal"]): StreamHandle {
  const terminal: StreamPart = { type: "finish", reason: "error" };
  const failure = Object.assign(new Error(error.message), {
    userVisible: true as const,
    toolCallIds: error.toolCallIds,
  });
  const response = Promise.reject(failure);
  const usage = Promise.reject(failure);
  void response.catch(() => undefined);
  void usage.catch(() => undefined);
  notifyTerminal(onTerminal, [terminal]);
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        yield terminal;
      },
    },
    response,
    usage,
  };
}

export function createManagedPromptSession(config: ManagedSessionConfig): PromptSession {
  if (!config.transcriptWrites) config.transcriptWrites = [];
  if (!config.providerCalls) config.providerCalls = { count: 0 };
  return {
    stream(request = {}) {
      if (hasImage(request) && !config.vision) {
        return failedHandle(
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
