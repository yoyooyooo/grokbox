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

export type VisibleFailure = {
  userVisible: true;
  message: string;
  toolCallIds?: string[];
};

export type ManagedSessionConfig = {
  modelId: string;
  vision: boolean;
  parallel: "allow" | "fail-closed";
  parts: StreamPart[];
  transcriptWrites?: unknown[];
  providerCalls?: { count: number };
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

function failedHandle(error: VisibleFailure): StreamHandle {
  const terminal: StreamPart = { type: "finish", reason: "error" };
  const failure = Object.assign(new Error(error.message), {
    userVisible: true as const,
    toolCallIds: error.toolCallIds,
  });
  const response = Promise.reject(failure);
  const usage = Promise.reject(failure);
  void response.catch(() => undefined);
  void usage.catch(() => undefined);
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
        return failedHandle({
          userVisible: true,
          message: "Configured model does not accept images.",
        });
      }

      const toolIds = collectToolIds(config.parts);
      if (toolIds.length > 1 && config.parallel === "fail-closed") {
        return failedHandle({
          userVisible: true,
          message: "Parallel tool calls are not supported by the configured model.",
          toolCallIds: toolIds,
        });
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
      return settledHandle(config.modelId, produced);
    },
  };
}
