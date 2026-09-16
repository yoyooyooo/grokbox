import { invalidStream, type InferenceEvent } from "@grokbox/runtime-kernel/contract";

// Existing provider-id normalization is collision checked. Distinct calls are
// NEVER dropped to disguise a parallel batch as a serial one; Host owns its
// all-or-nothing executable release gate.
const TOOL_ID_MAX = 128;
export type NonstandardOpenaiStreamState = { originalByRepaired: Map<string, string> };
export function createNonstandardOpenaiStreamState(): NonstandardOpenaiStreamState { return { originalByRepaired: new Map() }; }
export function repairOpenaiToolCallId(id: string): string {
  if (typeof id !== "string" || !id) throw invalidStream("tool_identity_conflict", "sdk_tool");
  const next = id.replace(/[\u0000-\u001F]/g, "");
  if (!next || next.length > TOOL_ID_MAX) throw invalidStream("tool_identity_conflict", "sdk_tool");
  return next;
}
export function admitNonstandardOpenaiEvent(event: InferenceEvent, state: NonstandardOpenaiStreamState): InferenceEvent {
  if (event.type !== "tool_start" && event.type !== "tool_delta" && event.type !== "tool_complete") return event;
  const toolCallId = repairOpenaiToolCallId(event.toolCallId);
  const original = state.originalByRepaired.get(toolCallId);
  if (original !== undefined && original !== event.toolCallId) throw invalidStream("tool_id_collision", "sdk_tool");
  state.originalByRepaired.set(toolCallId, event.toolCallId);
  return toolCallId === event.toolCallId ? event : { ...event, toolCallId };
}
