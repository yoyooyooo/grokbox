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
    const content = response.messages[0]?.content;
    if (typeof content === "string" && content.length > 0) {
      finalDeliveryCount = 1;
      transcriptEntryDelta += 1;
      transcriptSequenceDelta += 1;
    }
  } catch {
    /* managed error: Host loop keeps the failure, bodies stay local */
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
