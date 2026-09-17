import { BackendFailure, estimateContextText, type ContextSnapshot } from "@grokbox/runtime-kernel/contract";
import type { OpenaiPromptApi } from "./openai-prompt-adapter.ts";

/** Last egress check after dialect/reasoning/SDK encoding, before actual fetch.
 * It can refuse; it cannot crop messages, compact a root, or issue another call. */
export function verifyContextEgress(init: RequestInit | undefined, api: OpenaiPromptApi, budget?: ContextSnapshot["contextBudget"]): void {
  if (!budget) return;
  if (typeof init?.body !== "string") throw new BackendFailure("invalid_prepared_call");
  let body: Record<string, unknown>;
  try { body = JSON.parse(init.body); } catch { throw new BackendFailure("invalid_prepared_call"); }
  const output = api === "responses" ? body.max_output_tokens : body.max_completion_tokens ?? body.max_tokens;
  if (output !== budget.outputTokens) throw new BackendFailure("unsupported_options");
  const input = api === "responses" ? { input: body.input, instructions: body.instructions, tools: body.tools }
    : { messages: body.messages, tools: body.tools };
  // Canonical prepare includes a larger uncertainty margin; this independently
  // measures actual encoding overhead. It is a local estimate, not provider usage.
  if (estimateContextText(JSON.stringify(input)).tokens + 64 > budget.inputTokens) throw new BackendFailure("context_budget_exceeded");
}
