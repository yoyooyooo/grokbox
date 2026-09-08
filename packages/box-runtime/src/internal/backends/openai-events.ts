import {
  BackendFailure,
  applyInferenceEvent,
  emptyStreamValidation,
  finishInferenceStream,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown } from "./provider-error.ts";

type ToolNames = Map<string, string>;

function toolName(tools: ToolNames, id: string, incoming?: string): string {
  const existing = tools.get(id);
  if (incoming && existing && incoming !== existing) throw new BackendFailure("stream_invalid");
  if (incoming) {
    tools.set(id, incoming);
    return incoming;
  }
  if (!existing) throw new BackendFailure("stream_invalid");
  return existing;
}

/** SDK fullStream parts → canonical events. No Host finish.response. */
export function mapSdkStreamPart(part: unknown, tools: ToolNames): InferenceEvent | "skip" {
  if (!part || typeof part !== "object") throw new BackendFailure("stream_invalid");
  const rec = part as Record<string, unknown>;
  const type = rec.type;
  if (type === "text-delta") {
    const text = typeof rec.text === "string" ? rec.text : typeof rec.textDelta === "string" ? rec.textDelta : "";
    return { type: "text_delta", text };
  }
  if (type === "reasoning-delta") {
    const text = typeof rec.text === "string" ? rec.text : typeof rec.textDelta === "string" ? rec.textDelta : "";
    return { type: "reasoning_delta", text };
  }
  if (type === "tool-input-start" || type === "tool-call-streaming-start") {
    const id = String(rec.id ?? rec.toolCallId ?? "");
    const name = String(rec.toolName ?? "");
    if (!id || !name) throw new BackendFailure("stream_invalid");
    return { type: "tool_start", toolCallId: id, toolName: toolName(tools, id, name) };
  }
  if (type === "tool-input-delta" || type === "tool-call-delta") {
    const id = String(rec.id ?? rec.toolCallId ?? "");
    const delta = typeof rec.delta === "string" ? rec.delta : typeof rec.argsTextDelta === "string" ? rec.argsTextDelta : "";
    return { type: "tool_delta", toolCallId: id, toolName: toolName(tools, id), argsTextDelta: delta };
  }
  if (type === "tool-call") {
    const id = String(rec.toolCallId ?? rec.id ?? "");
    const name = String(rec.toolName ?? rec.name ?? "");
    if (!id || !name) throw new BackendFailure("stream_invalid");
    let args: unknown = rec.args ?? rec.input ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); }
      catch { throw new BackendFailure("stream_invalid"); }
    }
    return { type: "tool_complete", toolCallId: id, toolName: toolName(tools, id, name), args: args as never };
  }
  if (type === "finish") {
    const reason = rec.finishReason === "error" || rec.finishReason === "abort" ? rec.finishReason : "stop";
    const usageRaw = rec.totalUsage ?? rec.usage;
    const usage = usageRaw && typeof usageRaw === "object"
      ? {
        promptTokens: Number((usageRaw as { promptTokens?: number; inputTokens?: number }).promptTokens
          ?? (usageRaw as { inputTokens?: number }).inputTokens ?? 0),
        completionTokens: Number((usageRaw as { completionTokens?: number; outputTokens?: number }).completionTokens
          ?? (usageRaw as { outputTokens?: number }).outputTokens ?? 0),
      }
      : undefined;
    return { type: "backend_finish", finishReason: reason, ...(usage ? { usage } : {}) };
  }
  if (type === "error" || type === "abort") {
    if (type === "abort") return { type: "backend_finish", finishReason: "abort" };
    throw backendFailureFromUnknown(rec.error);
  }
  if (
    type === "start" || type === "start-step" || type === "finish-step" || type === "text-start" || type === "text-end"
    || type === "reasoning-start" || type === "reasoning-end" || type === "tool-input-end" || type === "raw"
    || type === "source" || type === "file" || type === "tool-result" || type === "tool-error"
  ) {
    return "skip";
  }
  throw new BackendFailure("stream_invalid");
}

export function validateCanonicalSequence(events: InferenceEvent[]): void {
  const state = emptyStreamValidation();
  for (const event of events) applyInferenceEvent(state, event);
  finishInferenceStream(state);
}

export { emptyStreamValidation };
