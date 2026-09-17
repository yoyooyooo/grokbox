import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, calculateContextTokens, estimateContextTokens, estimateTokens, findCutPoint, prepareCompaction, shouldCompact, type Entry, type Message } from "../src/internal/context/vendor/pi-compaction/core.ts";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "../src/internal/context/vendor/pi-compaction/prompts.ts";

const assistant = (text: string, input = 0, stopReason = "stop"): Message => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
  usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input },
});
const entries = (messages: Message[]): Entry[] => messages.map((message, i) => ({ type: "message", id: `source-${i}`, message }));

test("Pi boundary golden: local window and strict equality, not provider rejection", () => {
  expect(shouldCompact(111616, 128000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  expect(shouldCompact(111617, 128000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
  expect(shouldCompact(121000, 500000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  expect(shouldCompact(121000, 128000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
  expect(shouldCompact(500000, 128000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(false);
});
test("Pi usage golden: errors and zero usage never reset previous evidence", () => {
  expect(estimateContextTokens([assistant("", 120000), assistant("", 0, "error"), { role: "user", content: "x".repeat(4000) }]))
    .toEqual({ tokens: 121000, usageTokens: 120000, trailingTokens: 1000, lastUsageIndex: 0 });
  expect(estimateContextTokens([{ role: "user", content: "x".repeat(480000) }]))
    .toEqual({ tokens: 120000, usageTokens: 0, trailingTokens: 120000, lastUsageIndex: null });
  expect(estimateContextTokens([assistant("x".repeat(40), 999999, "aborted")]).tokens).toBe(10);
  expect(calculateContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 7 })).toBe(7);
});
test("Pi cut point excludes tool-result and exposes split-turn prefix without mutation", () => {
  const input = entries([
    { role: "user", content: "old request" },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "call-1", content: "x".repeat(400) },
    assistant("work complete"),
    { role: "user", content: "new request" },
    assistant("latest"),
  ]);
  const before = structuredClone(input);
  const cut = findCutPoint(input, 0, input.length, 15);
  expect(cut).toEqual({ firstKeptEntryIndex: 3, turnStartIndex: 0, isSplitTurn: true });
  const plan = prepareCompaction(input, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 15 }, "prior summary")!;
  expect(plan.messagesToSummarize).toHaveLength(0);
  expect(plan.turnPrefixMessages).toHaveLength(3);
  expect(plan.retainedTail).toHaveLength(3);
  expect(plan.previousSummary).toBe("prior summary");
  expect(input).toEqual(before);
  expect(input[cut.firstKeptEntryIndex]?.message.role).not.toBe("toolResult");
});
test("Pi estimate and retained prompts remain explicitly estimates and summarization-only", () => {
  expect(estimateTokens({ role: "user", content: [{ type: "image" }] })).toBe(1200);
  expect(estimateTokens(assistant("a".repeat(41)))).toBe(11);
  expect(SUMMARIZATION_SYSTEM_PROMPT).toContain("Do NOT continue the conversation");
  expect(SUMMARIZATION_PROMPT).toContain("## Critical Context");
  expect(UPDATE_SUMMARIZATION_PROMPT).toContain("previous-summary");
});
test("extraction contains no Pi runtime, filesystem, retry or Agent dependency", () => {
  const dir = resolve(import.meta.dir, "../src/internal/context/vendor/pi-compaction");
  for (const file of ["core.ts", "prompts.ts"]) {
    const text = readFileSync(resolve(dir, file), "utf8");
    expect(text).not.toMatch(/^import\s/m);
    expect(text).not.toContain("retryAssistantCall(");
    expect(text).not.toContain("new Agent");
    expect(text).not.toContain("fetch(");
  }
  expect(readFileSync(resolve(dir, "LICENSE"), "utf8")).toContain("Copyright (c) 2025 Mario Zechner");
  expect(readFileSync(resolve(dir, "PROVENANCE.md"), "utf8")).toContain("fcaeb2e25d5cedca80e3487f8ec02014b0e780b68e67c33d579af7b80cc91dd7");
});
