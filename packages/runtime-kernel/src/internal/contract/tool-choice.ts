import type { GenerationOptions } from "./context.ts";
import type { StreamDiagnostic, StreamRejectSite } from "./stream-diagnostic.ts";

export type ToolChoiceMode = "auto" | "none" | "required" | "tool";
export function toolChoiceMode(choice: GenerationOptions["toolChoice"]): ToolChoiceMode {
  return typeof choice === "object" ? "tool" : choice ?? "auto";
}
/** STEP-local response contract, not tool authorization or a parallelism quota.
 * Check real calls before releasing any executable material and successful
 * completion before a text-to-delivery projection can fabricate a call. */
export function toolChoiceViolation(
  choice: GenerationOptions["toolChoice"],
  observed: { toolName: string } | { completedCalls: number },
  rejectSite: StreamRejectSite,
): StreamDiagnostic | undefined {
  const mode = toolChoiceMode(choice);
  const reason = "toolName" in observed
    ? mode === "none" ? "forbidden" : typeof choice === "object" && observed.toolName !== choice.toolName ? "different_tool" : undefined
    : (mode === "required" || mode === "tool") && observed.completedCalls === 0 ? "missing_call" : undefined;
  return reason ? { normalizeCause: "tool_choice_mismatch", rejectSite, toolChoice: { mode, reason } } : undefined;
}
