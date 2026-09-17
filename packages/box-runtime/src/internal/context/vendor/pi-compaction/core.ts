/*
 * Adapted from @earendil-works/pi-agent-core 0.85.1, harness/compaction/compaction.js.
 * Copyright (c) 2025 Mario Zechner. MIT; see LICENSE and PROVENANCE.md here.
 * Extraction: types supplied locally; unsupported Pi application message kinds removed.
 * Policy, source identity, tool-group validation and budgets belong to the caller.
 */
export type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image" }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
export type Message = {
  role: "user" | "assistant" | "toolResult";
  content: string | readonly Part[];
  toolCallId?: string;
  toolName?: string;
  usage?: Usage;
  stopReason?: string;
};
export type Entry = { type: "message"; id: string; message: Message };
export type Settings = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
export const DEFAULT_COMPACTION_SETTINGS: Readonly<Settings> = Object.freeze({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(message: Message): Usage | undefined {
  if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error"
    && message.usage && calculateContextTokens(message.usage) > 0) return message.usage;
}
export function getLastAssistantUsage(entries: readonly Entry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(entries[i]!.message);
    if (usage) return usage;
  }
}
export function estimateContextTokens(messages: readonly Message[]): {
  tokens: number; usageTokens: number; trailingTokens: number; lastUsageIndex: number | null;
} {
  let usageInfo: { usage: Usage; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]!);
    if (usage) { usageInfo = { usage, index: i }; break; }
  }
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]!);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}
export function shouldCompact(contextTokens: number, contextWindow: number, settings: Settings): boolean {
  return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}
function contentChars(content: Message["content"]): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "image") chars += 4800;
  }
  return chars;
}
/** Pi's estimate, NOT a tokenizer or a universal upper bound. */
export function estimateTokens(message: Message): number {
  if (message.role !== "assistant") return Math.ceil(contentChars(message.content) / 4);
  // The projection always supplies assistant arrays; retain string support for callers.
  if (typeof message.content === "string") return Math.ceil(message.content.length / 4);
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
  }
  return Math.ceil(chars / 4);
}
export function findTurnStartIndex(entries: readonly Entry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) if (entries[i]!.message.role === "user") return i;
  return -1;
}
export function findCutPoint(entries: readonly Entry[], startIndex: number, endIndex: number, keepRecentTokens: number): {
  firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean;
} {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) if (entries[i]!.message.role !== "toolResult") cutPoints.push(i);
  if (!cutPoints.length) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    accumulatedTokens += estimateTokens(entries[i]!.message);
    if (accumulatedTokens >= keepRecentTokens) {
      for (const cut of cutPoints) if (cut >= i) { cutIndex = cut; break; }
      break;
    }
  }
  const isUser = entries[cutIndex]!.message.role === "user";
  const turnStartIndex = isUser ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUser && turnStartIndex !== -1 };
}

/** Adapted prepareCompaction: Host supplies an explicit previous-summary boundary;
 * no Pi session entries/virtual retained IDs are persisted or reconstructed here. */
export function prepareCompaction(entries: readonly Entry[], settings: Settings, previousSummary?: string) {
  if (!entries.length) return undefined;
  const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  return {
    ...cut,
    messagesToSummarize: entries.slice(0, historyEnd).map(entry => entry.message),
    turnPrefixMessages: cut.isSplitTurn ? entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).map(entry => entry.message) : [],
    retainedTail: entries.slice(cut.firstKeptEntryIndex).map(entry => entry.message),
    tokensBefore: estimateContextTokens(entries.map(entry => entry.message)).tokens,
    previousSummary,
    settings,
  };
}
