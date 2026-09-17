import {
  BackendFailure, StreamOutputBudget, applyInferenceEvent, emptyStreamValidation,
  finishInferenceStream, invalidStream, annotateStreamFailure, observedStreamType, StreamEvidence,
  type InferenceEvent, type InferenceUsage,
} from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown } from "./provider-error.ts";
import { incompleteBackendFinish } from "./failure-observation.ts";
import { admitNonstandardOpenaiEvent, createNonstandardOpenaiStreamState } from "./nonstandard-endpoint.ts";
import type { ToolIdentityObserver } from "./tool-identity-audit.ts";

type ToolNames = Map<string, string>;
function toolName(tools: ToolNames, id: string, incoming?: string): string {
  const existing = tools.get(id);
  if (incoming && existing && incoming !== existing) throw invalidStream("tool_identity_conflict", "sdk_tool");
  if (incoming) { tools.set(id, incoming); return incoming; }
  if (!existing) throw invalidStream("tool_identity_conflict", "sdk_tool");
  return existing;
}
function readUsage(raw: unknown): InferenceUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const prompt = r.promptTokens ?? r.inputTokens ?? r.prompt_tokens;
  const completion = r.completionTokens ?? r.outputTokens ?? r.completion_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || !Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || prompt < 0 || completion < 0) return undefined;
  const read = r.cacheReadTokens ?? r.cache_read_tokens ?? r.cachedInputTokens;
  const write = r.cacheWriteTokens ?? r.cache_write_tokens;
  return { promptTokens: prompt, completionTokens: completion,
    ...(typeof read === "number" && Number.isSafeInteger(read) && read >= 0 ? { cacheReadTokens: read } : {}),
    ...(typeof write === "number" && Number.isSafeInteger(write) && write >= 0 ? { cacheWriteTokens: write } : {}) };
}
function finishReasonOf(value: unknown): "stop" | "error" | "abort" | null {
  if (value === "error") return "error";
  if (value === "abort" || value === "cancelled") return "abort";
  if (value === "length" || value === "content-filter") throw incompleteBackendFinish(value);
  if (value === "stop" || value === "end-turn" || value === "tool-calls") return "stop";
  return null;
}
/** SDK parts → canonical events. Never executes tools or guesses a missing finish. */
export function mapSdkStreamPart(part: unknown, tools: ToolNames): InferenceEvent | "skip" {
  if (!part || typeof part !== "object") throw invalidStream("invalid_event_shape", "sdk_part");
  const r = part as Record<string, unknown>, type = r.type;
  if (type === "text-delta" || type === "reasoning-delta") {
    const text = typeof r.text === "string" ? r.text : typeof r.textDelta === "string" ? r.textDelta : r.delta;
    if (typeof text !== "string") throw invalidStream("invalid_event_shape", "sdk_part");
    return { type: type === "text-delta" ? "text_delta" : "reasoning_delta", text };
  }
  if (type === "tool-input-start" || type === "tool-call-streaming-start") {
    const id = r.id ?? r.toolCallId, name = r.toolName;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw invalidStream("invalid_event_shape", "sdk_tool");
    return { type: "tool_start", toolCallId: id, toolName: toolName(tools, id, name) };
  }
  if (type === "tool-input-delta" || type === "tool-call-delta") {
    const id = r.id ?? r.toolCallId, delta = typeof r.delta === "string" ? r.delta : r.argsTextDelta;
    if (typeof id !== "string" || !id || typeof delta !== "string") throw invalidStream("invalid_event_shape", "sdk_tool");
    return { type: "tool_delta", toolCallId: id, toolName: toolName(tools, id), argsTextDelta: delta };
  }
  if (type === "tool-call") {
    if (r.invalid === true) throw invalidStream("sdk_invalid_tool", "sdk_tool");
    const id = r.toolCallId ?? r.id, name = r.toolName ?? r.name;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw invalidStream("invalid_event_shape", "sdk_tool");
    const raw = r.args ?? r.input;
    if (raw === undefined) throw invalidStream("tool_arguments_invalid", "sdk_tool");
    let args = raw;
    if (typeof raw === "string") { try { args = JSON.parse(raw); } catch { throw invalidStream("tool_arguments_invalid", "sdk_tool"); } }
    return { type: "tool_complete", toolCallId: id, toolName: toolName(tools, id, name), args: args as never };
  }
  if (type === "finish") {
    const reason = finishReasonOf(r.finishReason);
    if (reason === null) throw invalidStream("unsupported_finish_reason", "sdk_finish");
    const usage = readUsage(r.totalUsage ?? r.usage);
    return { type: "backend_finish", finishReason: reason, ...(usage ? { usage } : {}) };
  }
  if (type === "error" || type === "tool-error") {
    const inner = r.error;
    throw inner instanceof BackendFailure ? inner : backendFailureFromUnknown(inner instanceof Error ? inner : r);
  }
  if (type === "abort") return { type: "backend_finish", finishReason: "abort" };
  if (["stream-start", "response-metadata", "start", "start-step", "finish-step", "text-start", "text-end", "reasoning-start", "reasoning-end", "tool-input-end", "raw", "source", "file", "tool-result"].includes(String(type))) return "skip";
  throw invalidStream("unsupported_sdk_part", "sdk_part");
}
export function mapSdkStreamForHost(part: unknown, tools: ToolNames, nonstandard: ReturnType<typeof createNonstandardOpenaiStreamState>): InferenceEvent | "skip" {
  const mapped = mapSdkStreamPart(part, tools);
  return mapped === "skip" ? mapped : admitNonstandardOpenaiEvent(mapped, nonstandard);
}
/** Both production and conformance use this state machine. A terminal is held
 * until EOF, so late SDK/transport failures cannot hide behind a released success. */
export function createSdkStreamNormalizer(options: { declaredTools?: ReadonlySet<string>; evidence?: StreamEvidence; toolIdentity?: ToolIdentityObserver } = {}) {
  const names = new Map<string, string>(), state = emptyStreamValidation();
  const nonstandard = createNonstandardOpenaiStreamState(), evidence = options.evidence ?? new StreamEvidence();
  let terminal: Extract<InferenceEvent, { type: "backend_finish" }> | undefined;
  const budget = new StreamOutputBudget();
  const measure = () => {
    evidence.setCount("toolsStarted", state.tools.size); evidence.setCount("openTools", state.open.size);
    evidence.setCount("toolsCompleted", state.tools.size - state.open.size);
  };
  return {
    evidence,
    next(part: unknown): Exclude<InferenceEvent, { type: "backend_finish" }> | undefined {
      const r = part && typeof part === "object" ? part as Record<string, unknown> : {};
      evidence.increment("sdkParts"); evidence.first("sdkFirstPartMs"); evidence.note("sdk", r.type);
      if (r.type === "finish") evidence.sdkFinish(r.finishReason);
      if (r.invalid === true) evidence.invalidTool();
      if (r.type === "tool-input-start" || r.type === "tool-call-streaming-start" || r.type === "tool-call") {
        options.toolIdentity?.sdk(r.id ?? r.toolCallId, r.toolName ?? r.name);
      }
      try {
        if (r.type === "finish") {
          const summary = evidence.snapshot(), audit = summary.finishAudit;
          // The SDK keeps only the last finish reason. A later recognized value
          // must not erase an earlier unsupported or contradictory raw terminal.
          if (audit?.conflict) throw invalidStream("conflicting_finish_reason", "sdk_finish");
          if ((audit?.fields.unknown ?? 0) || (audit?.fields.invalid_type ?? 0)) throw invalidStream("unsupported_finish_reason", "sdk_finish");
          // Preserve legacy fields' meaning; blank placeholders are not an
          // affirmative terminal and cannot authorize completion.
          if (r.finishReason === "unknown" && (audit ? !audit.lastTerminal : summary.providerFinishObserved === false)) {
            throw invalidStream("missing_finish", "sdk_finish");
          }
        }
        const event = mapSdkStreamForHost(part, names, nonstandard);
        if (event === "skip") { evidence.increment("eventsSkipped"); return undefined; }
        if ((event.type === "tool_start" || event.type === "tool_delta" || event.type === "tool_complete") && options.declaredTools && !options.declaredTools.has(event.toolName)) {
          throw annotateStreamFailure(invalidStream("undeclared_tool", "sdk_tool"), { declaredToolMatch: false });
        }
        applyInferenceEvent(state, event); measure();
        const size = new TextEncoder().encode(JSON.stringify(event)).length;
        const withinBudget = budget.add(event);
        evidence.setCount("semanticOutputBytes", budget.used);
        if (!withinBudget) throw annotateStreamFailure(new BackendFailure("stream_limit"), { normalizeCause: "stream_budget", rejectSite: "canonical_event", budget: { layer: "canonical", metric: "output_bytes", limit: budget.limit, measured: budget.used } });
        evidence.increment("canonicalEvents"); evidence.increment("canonicalBytes", size); evidence.first("canonicalFirstEventMs"); evidence.note("canonical", event.type, size);
        if (event.type === "text_delta") evidence.increment("textBytes", new TextEncoder().encode(event.text).length);
        if (event.type === "reasoning_delta") evidence.increment("reasoningBytes", new TextEncoder().encode(event.text).length);
        if (event.type === "tool_delta") evidence.increment("toolArgumentBytes", new TextEncoder().encode(event.argsTextDelta).length);
        if (event.type === "backend_finish") { terminal = event; return undefined; }
        return event;
      } catch (error) {
        measure();
        if (error && typeof error === "object") annotateStreamFailure(error, { eventType: observedStreamType(r.type), stream: evidence.snapshot() });
        throw error;
      }
    },
    finish(): Extract<InferenceEvent, { type: "backend_finish" }> {
      try { finishInferenceStream(state); }
      catch (error) { measure(); if (error && typeof error === "object") annotateStreamFailure(error, { stream: evidence.snapshot() }); throw error; }
      return { ...terminal!, stream: evidence.snapshot() };
    },
  };
}
export async function drainSdkStream(parts: AsyncIterable<unknown>, emit: (event: InferenceEvent) => void): Promise<void> {
  const normalizer = createSdkStreamNormalizer();
  for await (const part of parts) { const event = normalizer.next(part); if (event) emit(event); }
  emit(normalizer.finish());
}
export function validateCanonicalSequence(events: InferenceEvent[]): void {
  const state = emptyStreamValidation();
  for (const event of events) applyInferenceEvent(state, event);
  finishInferenceStream(state);
}
export { emptyStreamValidation };
