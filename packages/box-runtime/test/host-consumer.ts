import type {
  HostPromptSession,
  HostStreamResult,
  PromptSession,
  StreamHandle,
  StreamPart,
  StreamRequest,
} from "../src/session.ts";

export type HostSideEffectVector = {
  toolExecutionCount: number;
  finalDeliveryCount: number;
  transcriptEntryDelta: number;
  transcriptSequenceDelta: number;
  memoryIdDelta: number;
  duplicateCount: number;
};

export const SEAM_STOP_PARTS: StreamPart[] = [
  { type: "tool-call", toolCallId: "call-benign", toolName: "bash", args: { command: "true" } },
  { type: "tool-call", toolCallId: "call-memory", toolName: "memory_write", args: { text: "fixture-memory-body" } },
  { type: "text-delta", textDelta: "fixture-final-response" },
  { type: "finish", reason: "stop" },
];

async function consumeHandle(handle: StreamHandle | HostStreamResult): Promise<HostSideEffectVector> {
  const seen = new Set<string>();
  let toolExecutionCount = 0;
  let duplicateCount = 0;
  let memoryIdDelta = 0;
  let transcriptEntryDelta = 0;
  let transcriptSequenceDelta = 0;
  let text = "";

  for await (const part of handle.fullStream) {
    if (part.type === "tool-call") {
      if (seen.has(part.toolCallId)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(part.toolCallId);
      toolExecutionCount += 1;
      transcriptEntryDelta += 1;
      transcriptSequenceDelta += 1;
      if (part.toolName === "memory_write") memoryIdDelta += 1;
      continue;
    }
    if (part.type === "text-delta") text += part.textDelta;
  }

  let finalDeliveryCount = 0;
  try {
    const response = await handle.response;
    response.modelId.trim();
    response.messages.some((message) => message.role === "assistant");
    const content = response.messages[0]?.content;
    if (typeof content === "string" && content.length > 0) {
      finalDeliveryCount = 1;
      transcriptEntryDelta += 1;
      transcriptSequenceDelta += 1;
    }
  } catch {
    /* managed error: Host loop keeps the failure, bodies stay local */
  }

  try {
    const usage = await handle.usage;
    void usage.promptTokens;
    void usage.completionTokens;
    void usage.totalTokens;
  } catch {
    /* usage rejection stays with the Host loop */
  }

  if ("extendedUsage" in handle) {
    try {
      await handle.extendedUsage;
    } catch {
      /* usage rejection stays with the Host loop */
    }
  }

  void text;
  return {
    toolExecutionCount,
    finalDeliveryCount,
    transcriptEntryDelta,
    transcriptSequenceDelta,
    memoryIdDelta,
    duplicateCount,
  };
}

export async function consumePromptSession(
  session: PromptSession,
  request?: StreamRequest,
): Promise<HostSideEffectVector> {
  return consumeHandle(session.stream(request));
}

export async function consumeHostSession(
  session: HostPromptSession,
  request?: StreamRequest,
): Promise<HostSideEffectVector> {
  session.getModelId().trim();
  const executor = session.getExecutor({});
  void session.getExecutorWithoutResolvedModelTracking({});
  return consumeHandle(executor.stream({}, undefined, undefined, request));
}

export async function collectStreamParts(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

type WriterFork<T> = {
  write: (value: T) => Promise<void>;
  close: () => void;
  iterable: AsyncIterable<T>;
};

function createWritableIterable<T>(): WriterFork<T> {
  let pending: { value: T; taken: () => void } | undefined;
  let closed = false;
  let waitingRead: ((result: IteratorResult<T>) => void) | undefined;

  return {
    async write(value) {
      if (waitingRead) {
        waitingRead({ done: false, value });
        waitingRead = undefined;
        return;
      }
      await new Promise<void>((resolve) => {
        pending = { value, taken: resolve };
      });
    },
    close() {
      closed = true;
      if (waitingRead) {
        waitingRead({ done: true, value: undefined });
        waitingRead = undefined;
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            if (pending) {
              const item = pending;
              pending = undefined;
              item.taken();
              return Promise.resolve({ done: false, value: item.value });
            }
            if (closed) return Promise.resolve({ done: true, value: undefined as T });
            return new Promise((resolve) => {
              waitingRead = resolve;
            });
          },
        };
      },
    },
  };
}

/** Host duplicateStream: pump the source immediately and await write() on both forks until a reader pulls. */
export function duplicateHostStream<T>(source: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
  const left = createWritableIterable<T>();
  const right = createWritableIterable<T>();
  void (async () => {
    try {
      for await (const part of source) {
        await left.write(part);
        await right.write(part);
      }
    } finally {
      left.close();
      right.close();
    }
  })();
  return [left.iterable, right.iterable];
}

/** Live Host attaches the UI fork later than the tool-loop reader. */
const HOST_DUPLICATE_SECOND_READER_DELAY_MS = 20;

export async function collectHostDuplicateStream(
  source: AsyncIterable<StreamPart>,
  timeoutMs = 2000,
): Promise<[StreamPart[], StreamPart[]]> {
  const [inner, full] = duplicateHostStream(source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const innerParts = collectStreamParts(inner);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HOST_DUPLICATE_SECOND_READER_DELAY_MS);
    });
    const fullParts = collectStreamParts(full);
    return await Promise.race([
      Promise.all([innerParts, fullParts]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host duplicateStream deadlock")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
