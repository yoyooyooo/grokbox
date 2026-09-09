import type { InferenceEvent } from "@grokbox/runtime-kernel/contract";
import type { FinishReason, HostUsage, StreamPart } from "./session.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unique Host reshape. Canonical events are not Host StreamPart aliases. */
export function reshapeInferenceEvent(event: unknown): StreamPart | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  if (event.type === "text_delta" && typeof event.text === "string") {
    return { type: "text-delta", textDelta: event.text };
  }
  if (event.type === "reasoning_delta" && typeof event.text === "string") {
    return { type: "reasoning", textDelta: event.text };
  }
  if (event.type === "tool_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    return { type: "tool-call-streaming-start", toolCallId: event.toolCallId, toolName: event.toolName };
  }
  if (event.type === "tool_delta" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && typeof event.argsTextDelta === "string") {
    return { type: "tool-call-delta", toolCallId: event.toolCallId, toolName: event.toolName, argsTextDelta: event.argsTextDelta };
  }
  if (event.type === "tool_complete" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    return { type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
  }
  return undefined;
}

export function reshapeInferenceEvents(events: InferenceEvent[]): StreamPart[] {
  return events.map(reshapeInferenceEvent).filter((part): part is StreamPart => part !== undefined);
}

export function usageFromTerminal(value: unknown): HostUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : value;
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens);
  const completion = Number(usage.completionTokens ?? usage.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

export function finishFromTerminal(value: unknown): { reason: FinishReason; usage?: HostUsage } | undefined {
  if (!isRecord(value) || value.kind !== "terminal") return undefined;
  if (value.outcome === "ok") {
    const finish = value.finishReason;
    const reason: FinishReason = finish === "abort" || finish === "error" ? finish : "stop";
    return { reason, ...(usageFromTerminal(value.usage) ? { usage: usageFromTerminal(value.usage) } : {}) };
  }
  if (value.outcome === "error" || value.outcome === "duplicate") {
    return { reason: "error" };
  }
  return undefined;
}
