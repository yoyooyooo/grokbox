import { Effect, Layer } from "effect";
import { ContextCompactionAlgorithm, type ContextSummaryRequest } from "@grokbox/runtime-kernel/ports";
import { ContextFailure, contextFailure, measureContext, parseContextMaterial, estimateContextText,
  type ContextBudget, type ContextPlan, type PromptMessage } from "@grokbox/runtime-kernel/contract";
import { planPiCompaction, boundedSummarySegments } from "./pi-projection.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT, TURN_PREFIX_SUMMARIZATION_PROMPT } from "./vendor/pi-compaction/prompts.ts";

/** Adapted Pi request boundary. The supplied Effect is the only route to a model;
 * no runtime construction, implicit retry, credentials, session store or tools. */
export function generatePiSummary(plan: ContextPlan, budget: ContextBudget, request: ContextSummaryRequest) {
  const ask = (text: string, phase: "source" | "merge", index: number, count: number) => Effect.gen(function* () {
    const instructions = phase === "merge" || plan.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    const prompt = `[${phase} segment ${index + 1}/${count}]\n<conversation>\n${text}\n</conversation>\n\n${instructions}`
      + (plan.splitTurn && phase === "source" ? `\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}` : "");
    const messages: PromptMessage[] = [{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT }, { role: "user", content: prompt }];
    const measured = measureContext({ messages: messages.map((message, i) => ({ ref: `summary-${i}`, message })), tools: [] });
    if (measured.tokens > budget.inputTokens) return yield* Effect.fail(new ContextFailure("context_budget_exceeded"));
    const result = yield* request({ messages, maxOutputTokens: budget.outputTokens });
    if (result.finishReason !== "stop" || typeof result.text !== "string" || !result.text.trim()) {
      return yield* Effect.fail(new ContextFailure("summary_invalid"));
    }
    // A provider may ignore max_tokens. Never accept its oversized result.
    if (estimateContextText(result.text).tokens > budget.outputTokens) {
      return yield* Effect.fail(new ContextFailure("summary_invalid"));
    }
    return result.text;
  });
  return Effect.gen(function* () {
    if (!plan.chunks.length) return yield* Effect.fail(new ContextFailure("no_improvement"));
    let summaries: string[] = [];
    for (let i = 0; i < plan.chunks.length; i++) summaries.push(yield* ask(plan.chunks[i]!, "source", i, plan.chunks.length));
    // Every merge is another caller-owned request, counted against one operation.
    // Segment the combined summaries too; never send an unchecked concatenation.
    for (let round = 0; summaries.length > 1; round++) {
      if (round >= 16) return yield* Effect.fail(new ContextFailure("maintenance_budget_exhausted"));
      const joined = summaries.map((summary, i) => `\n[partial summary ${i + 1}]\n${summary}\n`);
      const segments = boundedSummarySegments(joined, Math.floor(budget.inputTokens / 1.2) - 2048);
      const next: string[] = [];
      for (let i = 0; i < segments.length; i++) next.push(yield* ask(segments[i]!, "merge", i, segments.length));
      if (next.length >= summaries.length && next.join("").length >= summaries.join("").length) {
        return yield* Effect.fail(new ContextFailure("no_improvement"));
      }
      summaries = next;
    }
    return summaries[0]!;
  }).pipe(Effect.mapError(error => contextFailure(error)));
}

export const piCompactionAlgorithmLayer = Layer.succeed(ContextCompactionAlgorithm, {
  measure: material => Effect.try({ try: () => measureContext(parseContextMaterial(material)), catch: error => contextFailure(error, "context_material_invalid") }),
  plan: (material, budget, summaryBudget) => Effect.try({ try: () => planPiCompaction(material, budget, summaryBudget.inputTokens), catch: error => contextFailure(error, "context_material_invalid") }),
  generate: (plan, budget, request) => generatePiSummary(plan, budget, request),
});
