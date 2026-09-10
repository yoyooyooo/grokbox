import type { InferenceEvent } from "@grokbox/runtime-kernel/contract";
import type { FinishReason, HostUsage, StreamPart } from "./session.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ReshapeResult =
  | { kind: "part"; part: StreamPart }
  | { kind: "ignore" }
  | { kind: "invalid" };

/** Unique Host reshape. Known no-ops are ignore; unknown/malformed are invalid. */
export function reshapeInferenceEvent(event: unknown): ReshapeResult {
  if (!isRecord(event) || typeof event.type !== "string") return { kind: "invalid" };
  if (event.type === "backend_finish") return { kind: "ignore" };
  if (event.type === "text_delta") {
    if (typeof event.text !== "string") return { kind: "invalid" };
    return { kind: "part", part: { type: "text-delta", textDelta: event.text } };
  }
  if (event.type === "reasoning_delta") {
    if (typeof event.text !== "string") return { kind: "invalid" };
    return { kind: "part", part: { type: "reasoning", textDelta: event.text } };
  }
  if (event.type === "tool_start") {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return { kind: "invalid" };
    return { kind: "part", part: { type: "tool-call-streaming-start", toolCallId: event.toolCallId, toolName: event.toolName } };
  }
  if (event.type === "tool_delta") {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || typeof event.argsTextDelta !== "string") {
      return { kind: "invalid" };
    }
    return { kind: "part", part: { type: "tool-call-delta", toolCallId: event.toolCallId, toolName: event.toolName, argsTextDelta: event.argsTextDelta } };
  }
  if (event.type === "tool_complete") {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return { kind: "invalid" };
    return { kind: "part", part: { type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args } };
  }
  return { kind: "invalid" };
}

export function reshapeInferenceEvents(events: InferenceEvent[]): StreamPart[] {
  const parts: StreamPart[] = [];
  for (const event of events) {
    const result = reshapeInferenceEvent(event);
    if (result.kind === "part") parts.push(result.part);
  }
  return parts;
}

export function usageFromTerminal(value: unknown): HostUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : value;
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens);
  const completion = Number(usage.completionTokens ?? usage.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return undefined;
  const cacheRead = Number(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cache_write_tokens);
  return {
    promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion,
    ...(Number.isFinite(cacheRead) && cacheRead >= 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isFinite(cacheWrite) && cacheWrite >= 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

export function finishFromTerminal(value: unknown): { reason: FinishReason; usage?: HostUsage } | undefined {
  if (!isRecord(value) || value.kind !== "terminal") return undefined;
  if (value.outcome === "ok") {
    const finish = value.finishReason;
    const reason: FinishReason = finish === "abort" || finish === "error" ? finish : "stop";
    const usage = usageFromTerminal(value.usage);
    return { reason, ...(usage ? { usage } : {}) };
  }
  if (value.outcome === "error" || value.outcome === "duplicate") {
    return { reason: "error" };
  }
  return undefined;
}
