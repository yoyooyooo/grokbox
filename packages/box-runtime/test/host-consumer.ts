import type {
  HostPromptSession,
  HostResponse,
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

function hasMeaningfulContentPart(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const part = value as { type?: unknown; text?: unknown };
  if (part.type === "text" || part.type === "reasoning") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  return part.type === "tool-call" || part.type === "file";
}

/** Mirrors the Host gate immediately before an empty response is synthesized. */
export function hasMeaningfulResponseMessageContent(messages: HostResponse["messages"]): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    if (typeof message.content === "string") return message.content.trim().length > 0;
    return message.content.some(hasMeaningfulContentPart);
  });
}

export async function consumeHandle(handle: StreamHandle | HostStreamResult): Promise<HostSideEffectVector> {
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
    if (hasMeaningfulResponseMessageContent(response.messages)) {
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
  invocationId?: string,
): Promise<HostSideEffectVector> {
  session.getModelId().trim();
  const executor = session.getExecutor({});
  void session.getExecutorWithoutResolvedModelTracking({});
  return consumeHandle(executor.stream({}, invocationId));
}

export async function collectStreamParts(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

type PendingReader<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};

type WriterFork<T> = {
  write: (value: T) => Promise<void>;
  close: () => void;
  fail: (error: unknown) => void;
  iterable: AsyncIterable<T>;
};

/** Test copy of the Host's backpressured createWritableIterable contract. */
function createWritableIterable<T>(): WriterFork<T> {
  const readQueue: PendingReader<T>[] = [];
  const writeQueue: T[] = [];
  let closed = false;
  let failure: unknown;
  let nextResolve: () => void = () => {};
  let nextReject: (error: unknown) => void = () => {};

  const createNextPromise = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      nextResolve = resolve;
      nextReject = reject;
    });
  let nextPromise = createNextPromise();
  void nextPromise.catch(() => {});

  const drainReads = (result: IteratorResult<T>, error?: unknown): void => {
    while (readQueue.length > 0) {
      const reader = readQueue.shift()!;
      if (error !== undefined) reader.reject(error);
      else reader.resolve(result);
    }
  };

  const fork: WriterFork<T> = {
    async write(value) {
      if (closed) throw failure ?? new Error("WritableIterable is closed");
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve({ done: false, value });
        if (readQueue.length > 0) return;
      } else {
        writeQueue.push(value);
      }
      const waitCount = writeQueue.length + 1;
      for (let index = 0; index < waitCount; index += 1) await nextPromise;
    },
    close() {
      if (closed) return;
      closed = true;
      writeQueue.length = 0;
      nextResolve();
      drainReads({ done: true, value: undefined as T });
    },
    fail(error) {
      if (closed) return;
      closed = true;
      failure = error;
      writeQueue.length = 0;
      nextReject(error);
      drainReads({ done: true, value: undefined as T }, error);
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            nextResolve();
            nextPromise = createNextPromise();
            void nextPromise.catch(() => {});
            if (writeQueue.length > 0) {
              return Promise.resolve({ done: false, value: writeQueue.shift()! });
            }
            if (closed) {
              return failure === undefined
                ? Promise.resolve({ done: true, value: undefined as T })
                : Promise.reject(failure);
            }
            return new Promise<IteratorResult<T>>((resolve, reject) => {
              readQueue.push({ resolve, reject });
            });
          },
        };
      },
    },
  };
  return fork;
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
    } catch (error) {
      left.fail(error);
      right.fail(error);
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
