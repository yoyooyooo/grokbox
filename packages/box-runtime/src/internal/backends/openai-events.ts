import {
  BackendFailure,
  applyInferenceEvent,
  emptyStreamValidation,
  finishInferenceStream,
  type InferenceEvent,
  type InferenceUsage,
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

function readUsage(raw: unknown): InferenceUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const prompt = rec.promptTokens ?? rec.inputTokens ?? rec.prompt_tokens;
  const completion = rec.completionTokens ?? rec.outputTokens ?? rec.completion_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || !Number.isFinite(prompt) || !Number.isFinite(completion)) {
    return undefined;
  }
  return { promptTokens: prompt, completionTokens: completion };
}

function finishReasonOf(value: unknown): "stop" | "error" | "abort" | null {
  if (value === "error") return "error";
  if (value === "abort" || value === "cancelled") return "abort";
  if (value === "stop" || value === "end-turn" || value === "length" || value === "tool-calls" || value === "content-filter") {
    return "stop";
  }
  return null;
}

/** SDK fullStream parts → canonical events. No Host finish.response. No invented 0/0 usage. */
export function mapSdkStreamPart(part: unknown, tools: ToolNames): InferenceEvent | "skip" {
  if (!part || typeof part !== "object") throw new BackendFailure("stream_invalid");
  const rec = part as Record<string, unknown>;
  const type = rec.type;
  if (type === "text-delta") {
    const text = typeof rec.text === "string" ? rec.text : typeof rec.textDelta === "string" ? rec.textDelta : typeof rec.delta === "string" ? rec.delta : "";
    return { type: "text_delta", text };
  }
  if (type === "reasoning-delta") {
    const text = typeof rec.text === "string" ? rec.text : typeof rec.textDelta === "string" ? rec.textDelta : typeof rec.delta === "string" ? rec.delta : "";
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
    const rawArgs = rec.args ?? rec.input;
    if (rawArgs === undefined) throw new BackendFailure("stream_invalid");
    let args: unknown = rawArgs;
    if (typeof args === "string") {
      try { args = JSON.parse(args); }
      catch { throw new BackendFailure("stream_invalid"); }
    }
    return { type: "tool_complete", toolCallId: id, toolName: toolName(tools, id, name), args: args as never };
  }
  if (type === "finish") {
    const reason = finishReasonOf(rec.finishReason);
    if (reason == null) throw new BackendFailure("stream_invalid");
    const usage = readUsage(rec.totalUsage ?? rec.usage);
    return { type: "backend_finish", finishReason: reason, ...(usage ? { usage } : {}) };
  }
  if (type === "error" || type === "tool-error") {
    throw backendFailureFromUnknown(rec.error ?? rec);
  }
  if (type === "abort") return { type: "backend_finish", finishReason: "abort" };
  if (
    type === "start" || type === "start-step" || type === "finish-step" || type === "text-start" || type === "text-end"
    || type === "reasoning-start" || type === "reasoning-end" || type === "tool-input-end" || type === "raw"
    || type === "source" || type === "file" || type === "tool-result"
  ) {
    return "skip";
  }
  throw new BackendFailure("stream_invalid");
}

export async function drainSdkStream(
  parts: AsyncIterable<unknown>,
  emit: (event: InferenceEvent) => void,
): Promise<void> {
  const names = new Map<string, string>();
  const state = emptyStreamValidation();
  for await (const part of parts) {
    const mapped = mapSdkStreamPart(part, names);
    if (mapped === "skip") continue;
    applyInferenceEvent(state, mapped);
    if (mapped.type === "backend_finish" && state.open.size > 0) throw new BackendFailure("stream_invalid");
    emit(mapped);
  }
  finishInferenceStream(state);
}

export function validateCanonicalSequence(events: InferenceEvent[]): void {
  const state = emptyStreamValidation();
  for (const event of events) applyInferenceEvent(state, event);
  finishInferenceStream(state);
}

export { emptyStreamValidation };
