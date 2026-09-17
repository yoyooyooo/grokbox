import {
  CONTEXT_PAGE_MAX_BYTES, ContextFailure, estimateContextText, measureContext, parseContextMaterial,
  type ContextBudget, type ContextMaterial, type ContextPlan, type ContextSourceMessage, type PromptContentPart,
} from "@grokbox/runtime-kernel/contract";
import { findCutPoint, prepareCompaction, type Entry, type Message, type Part } from "./vendor/pi-compaction/core.ts";

const parts = (row: ContextSourceMessage): PromptContentPart[] => typeof row.message.content === "string"
  ? [{ type: "text", text: row.message.content }] : row.message.content;
const isUserInput = (row: ContextSourceMessage): boolean => row.message.role === "user"
  && parts(row).some(part => part.type !== "tool-result");

/** Pi owns the retention heuristic, never native source identities or metadata. */
export function projectPiEntries(material: ContextMaterial): { entries: Entry[]; sourceIndices: number[] } {
  const entries: Entry[] = [], sourceIndices: number[] = [];
  const push = (index: number, message: Message) => {
    entries.push({ type: "message", id: `${index}:${entries.length}`, message }); sourceIndices.push(index);
  };
  for (let index = 0; index < material.messages.length; index++) {
    const row = material.messages[index]!;
    if (row.message.role === "system" || row.summary) continue;
    let content: Part[] = [];
    const flush = () => {
      if (!content.length) return;
      if (row.message.role === "tool") throw new ContextFailure("context_material_invalid");
      push(index, { role: row.message.role === "assistant" ? "assistant" : "user", content }); content = [];
    };
    for (const part of parts(row)) {
      switch (part.type) {
        case "text": content.push({ type: "text", text: part.text }); break;
        case "reasoning": content.push({ type: "thinking", thinking: part.text }); break;
        case "image": content.push({ type: "image" }); break;
        case "tool-call": content.push({ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: part.args }); break;
        case "tool-result":
          flush();
          push(index, { role: "toolResult", toolCallId: part.toolCallId, toolName: part.toolName,
            content: typeof part.result === "string" ? part.result : JSON.stringify(part.result) });
          break;
      }
    }
    flush();
    if (!parts(row).length && row.message.role !== "tool") push(index, { role: row.message.role, content: [] });
  }
  return { entries, sourceIndices };
}

/** Associations are checked independently of Pi's role-based cut algorithm. */
function toolGroups(material: ContextMaterial): { indices: number[]; open: boolean }[] {
  const calls = new Map<string, { name: string; indices: number[]; returned: boolean }>();
  for (let index = 0; index < material.messages.length; index++) {
    const row = material.messages[index]!;
    if (row.message.role === "tool" && (typeof row.message.content === "string" || parts(row).some(p => p.type !== "tool-result"))) {
      throw new ContextFailure("context_material_invalid");
    }
    for (const part of parts(row)) {
      if (part.type === "tool-call") {
        if (calls.has(part.toolCallId)) throw new ContextFailure("context_material_invalid");
        calls.set(part.toolCallId, { name: part.toolName, indices: [index], returned: false });
      } else if (part.type === "tool-result") {
        const call = calls.get(part.toolCallId);
        if (!call || call.returned || (part.toolName !== undefined && part.toolName !== call.name)) throw new ContextFailure("context_material_invalid");
        call.returned = true; call.indices.push(index);
      }
    }
  }
  return [...calls.values()].map(call => ({ indices: call.indices, open: !call.returned }));
}
function closeGroups(retained: Set<number>, groups: ReturnType<typeof toolGroups>): void {
  // One source row can contain results from multiple calls. Closure must reach
  // a fixed point, not only make one pass over the call map.
  let changed: boolean;
  do {
    changed = false;
    for (const group of groups) if (group.open || group.indices.some(index => retained.has(index))) {
      for (const index of group.indices) if (!retained.has(index)) { retained.add(index); changed = true; }
    }
  } while (changed);
}
function withRows(material: ContextMaterial, indices: ReadonlySet<number>): ContextMaterial {
  return { ...material, messages: material.messages.filter((_, index) => indices.has(index)) };
}

/** Complete bounded text segments. This is NOT a provider tool-message splitter:
 * original protocol messages stay in the Host and are mapped by source refs. */
export function boundedSummarySegments(texts: readonly string[], tokenLimit: number): string[] {
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 64) throw new ContextFailure("context_target_unreachable");
  const limit = Math.min(tokenLimit, Math.floor(CONTEXT_PAGE_MAX_BYTES / 4));
  const chunks: string[] = [];
  let current = "";
  for (const text of texts) {
    let offset = 0;
    while (offset < text.length) {
      let low = 0, high = Math.min(text.length - offset, CONTEXT_PAGE_MAX_BYTES);
      // Binary search keeps request preparation bounded even for one giant result.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = text.slice(offset, offset + mid);
        const measure = estimateContextText(candidate);
        if (measure.tokens <= limit && measure.bytes <= CONTEXT_PAGE_MAX_BYTES - 128) low = mid;
        else high = mid - 1;
      }
      if (low === 0) throw new ContextFailure("context_material_too_large");
      // Do not split a UTF-16 surrogate pair between adjacent segments.
      if (offset + low < text.length && /[\uD800-\uDBFF]/.test(text[offset + low - 1]!)) low--;
      if (low === 0) throw new ContextFailure("context_material_too_large");
      const next = text.slice(offset, offset + low);
      if (current && (estimateContextText(current + next).tokens > limit
        || estimateContextText(current + next).bytes > CONTEXT_PAGE_MAX_BYTES - 128)) {
        chunks.push(current); current = "";
      }
      current += next; offset += low;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function planPiCompaction(input: ContextMaterial, budget: ContextBudget, summaryInputBudget: number): ContextPlan {
  const material = parseContextMaterial(input), before = measureContext(material);
  const groups = toolGroups(material);
  const mandatory = new Set<number>();
  let latestUser = -1;
  for (let index = 0; index < material.messages.length; index++) {
    const row = material.messages[index]!;
    if (isUserInput(row) && !row.summary) latestUser = index;
    // Image summarization requires a qualified multimodal summary strategy.
    // Until then preserve the original image rather than fake textual coverage.
    if (row.preserve || (!row.summary && row.message.role === "system") || parts(row).some(p => p.type === "image")) mandatory.add(index);
  }
  if (latestUser >= 0) mandatory.add(latestUser);
  closeGroups(mandatory, groups);
  const fixed = measureContext(withRows(material, mandatory));
  if (fixed.tokens > budget.inputTokens) throw new ContextFailure("context_fixed_input_too_large");
  if (fixed.tokens > budget.resumeThresholdTokens) throw new ContextFailure("context_target_unreachable");
  const { entries, sourceIndices } = projectPiEntries(material);
  const previous = material.messages.filter((row, index) => row.summary && !mandatory.has(index));
  if (previous.some(row => parts(row).some(p => p.type !== "text"))) throw new ContextFailure("context_material_invalid");
  const previousSummary = previous.map(row => parts(row).map(p => p.type === "text" ? p.text : "").join("\n")).join("\n");
  const prepared = prepareCompaction(entries, { enabled: true, reserveTokens: budget.reserveTokens, keepRecentTokens: budget.keepRecentTokens }, previousSummary || undefined);
  const cut = prepared ?? findCutPoint(entries, 0, entries.length, budget.keepRecentTokens);
  let retained = new Set(mandatory);
  for (let index = cut.firstKeptEntryIndex; index < sourceIndices.length; index++) retained.add(sourceIndices[index]!);
  closeGroups(retained, groups);
  // A very small requested window can make Pi's character estimate optimistic.
  // Move only toward a newer legal source boundary, never split a tool group.
  let kept = measureContext(withRows(material, retained));
  if (kept.tokens > budget.preferredTargetTokens) {
    retained = new Set(mandatory);
    for (let index = material.messages.length - 1; index >= 0; index--) {
      if (material.messages[index]!.summary || mandatory.has(index)) continue;
      const candidate = new Set(retained); candidate.add(index); closeGroups(candidate, groups);
      const measured = measureContext(withRows(material, candidate));
      if (measured.tokens > budget.preferredTargetTokens) break;
      retained = candidate;
    }
    kept = measureContext(withRows(material, retained));
  }
  const summarized = material.messages.filter((_, index) => !retained.has(index));
  if (!summarized.length) throw new ContextFailure("no_improvement");
  const texts = summarized.map(row => `\n[source:${JSON.stringify(row.ref)} role:${row.message.role}${row.summary ? " previous-summary" : ""}]\n${JSON.stringify(row.message.content)}\n`);
  // Reserve ample instruction/framing margin; each actual encoded summary
  // request is measured independently again by the execution owner.
  const chunks = boundedSummarySegments(texts, Math.floor(summaryInputBudget / 1.2) - 2048);
  return { sourceRootRevision: material.rootRevision, summarizedRefs: summarized.map(row => row.ref),
    retainedRefs: material.messages.filter((_, index) => retained.has(index)).map(row => row.ref),
    ...(previousSummary ? { previousSummary } : {}), chunks, before, fixed, retained: kept,
    splitTurn: cut.isSplitTurn, effectiveKeepRecentTokens: Math.max(0, kept.tokens - fixed.tokens) };
}
