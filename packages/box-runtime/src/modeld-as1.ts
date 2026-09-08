import type { ModelEnvelope } from "./envelope.ts";
import type { ModelPin, ModeldDriver } from "./modeld.ts";
import { STUB_ECHO_MODEL_ID } from "./models.ts";
import type { ModelRecord } from "./models.ts";
import type { StreamPart } from "./session.ts";

/** Skeleton provider id. Not an admit list; CLI default remains stub/echo. */
export const AS1_SKELETON_PROVIDER = "as1";

/** Provider-shaped chunks. An SDK adapter maps stream events into these, then S1 buffers them. */
export type As1GenerateChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "finish"; reason?: "stop" | "error" | "abort" };

export type As1GenerateRequest = {
  pin: ModelPin;
  envelope: ModelEnvelope;
  invocationId: string;
  agentId: string;
  signal: AbortSignal;
};

/** Injected generate port. Real AI SDK stays behind this; this module does not import SDK packages. */
export type As1GeneratePort = (
  request: As1GenerateRequest,
) => AsyncIterable<As1GenerateChunk> | Promise<AsyncIterable<As1GenerateChunk>>;

export function as1Accepts(model: Readonly<ModelRecord>): boolean {
  return model.provider === AS1_SKELETON_PROVIDER && model.id !== STUB_ECHO_MODEL_ID;
}

/** Buffer a generate iterable into the existing response-only `complete()` `StreamPart[]` (S1). */
export async function collectAs1Chunks(
  chunks: AsyncIterable<As1GenerateChunk>,
  signal: AbortSignal,
  onPart?: (part: StreamPart) => void | Promise<void>,
): Promise<StreamPart[]> {
  if (signal.aborted) throw new Error("cancelled");
  const parts: StreamPart[] = [];
  let finished = false;
  const emit = async (part: StreamPart) => { parts.push(part); await onPart?.(part); };
  for await (const chunk of chunks) {
    if (signal.aborted) throw new Error("cancelled");
    if (chunk.type === "text") {
      if (chunk.text.length === 0) continue;
      await emit({ type: "text-delta", textDelta: chunk.text });
      continue;
    }
    if (chunk.type === "reasoning") {
      if (chunk.text.length === 0) continue;
      await emit({ type: "reasoning", textDelta: chunk.text });
      continue;
    }
    if (chunk.type === "tool-call-start") {
      await emit({ type: "tool-call-streaming-start", toolCallId: chunk.toolCallId, toolName: chunk.toolName });
      continue;
    }
    if (chunk.type === "tool-call-delta") {
      await emit({
        type: "tool-call-delta",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        argsTextDelta: chunk.argsTextDelta,
      });
      continue;
    }
    if (chunk.type === "tool-call") {
      await emit({ type: "tool-call", toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.args });
      continue;
    }
    if (chunk.type === "error") {
      await emit({
        type: "error",
        error: { userVisible: true, code: chunk.code, message: chunk.message },
      });
      await emit({ type: "finish", reason: "error" });
      finished = true;
      break;
    }
    if (chunk.type === "finish") {
      await emit({ type: "finish", reason: chunk.reason ?? "stop" });
      finished = true;
      break;
    }
    const _never: never = chunk;
    throw new Error(`as1-unknown-chunk:${String(_never)}`);
  }
  if (signal.aborted) throw new Error("cancelled");
  if (!finished) await emit({ type: "finish", reason: "stop" });
  return parts;
}

/**
 * A = provider adapter as ModeldDriver. S1 = buffer generate chunks in `complete()`.
 * Reuses the existing admission/pin kernel. Not the CLI default driver.
 */
export function createAs1ModeldDriver(input: {
  generate: As1GeneratePort;
  accepts?: (model: Readonly<ModelRecord>) => boolean;
}): ModeldDriver {
  const accepts = input.accepts ?? as1Accepts;
  return {
    accepts,
    complete: async ({ pin, envelope, invocationId, agentId, signal, onPart }) => {
      if (signal.aborted) throw new Error("cancelled");
      const stream = await input.generate({ pin, envelope, invocationId, agentId, signal });
      if (signal.aborted) throw new Error("cancelled");
      return await collectAs1Chunks(stream, signal, onPart);
    },
  };
}
