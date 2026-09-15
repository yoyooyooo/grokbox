/**
 * Nonstandard endpoint adapters.
 *
 * Happy-path modules assume each side speaks its own contract:
 *   Host — one executable tool per model response; tool IDs without C0 controls
 *   OpenAI Chat/Responses — `parallel_tool_calls` / `max_tool_calls`; `call_id`
 *     is a single-line token
 *
 * Only this file may rewrite a side that broke that contract so the other side
 * can keep running. Do not fold these rewrites into `openai-prompt-adapter`,
 * `host-codec`, or the SDK part mapper.
 */
import { BackendFailure, type InferenceEvent } from "@grokbox/runtime-kernel/contract";

const C0_CONTROLS = /[\u0000-\u001F]/g;
const TOOL_ID_MAX = 128;

export type NonstandardOpenaiStreamState = {
  serialToolCallId?: string;
};

export function createNonstandardOpenaiStreamState(): NonstandardOpenaiStreamState {
  return {};
}

// ---------------------------------------------------------------------------
// OpenAI Chat / Responses — provider violated its own wire
// ---------------------------------------------------------------------------

/**
 * Observed: some Responses backends put LF/CR inside `call_id` (length ~85)
 * and ignore `parallel_tool_calls: false` / `max_tool_calls: 1`.
 * Host serial admission then rejects the whole batch (`parallel_tools`).
 */
export function repairOpenaiToolCallId(id: string): string {
  if (typeof id !== "string" || id.length === 0) throw new BackendFailure("stream_invalid");
  const next = id.replace(C0_CONTROLS, "");
  if (next.length === 0 || next.length > TOOL_ID_MAX) throw new BackendFailure("stream_invalid");
  return next;
}

export function admitNonstandardOpenaiEvent(
  event: InferenceEvent,
  state: NonstandardOpenaiStreamState,
): InferenceEvent | "drop" {
  if (event.type !== "tool_start" && event.type !== "tool_delta" && event.type !== "tool_complete") {
    return event;
  }
  const toolCallId = repairOpenaiToolCallId(event.toolCallId);
  const repaired = event.toolCallId === toolCallId ? event : { ...event, toolCallId };
  if (state.serialToolCallId === undefined) {
    state.serialToolCallId = toolCallId;
    return repaired;
  }
  if (state.serialToolCallId === toolCallId) return repaired;
  return "drop";
}

// ---------------------------------------------------------------------------
// Host — Host violated its own ABI
// ---------------------------------------------------------------------------
// None live. Host parallel fail-closed stays in session.ts. Do not execute a
// partial batch there; extras are dropped above so Host only sees one call.
// Host `validId` currently allows LF/CR; this module still strips them so we
// do not depend on that hole.
