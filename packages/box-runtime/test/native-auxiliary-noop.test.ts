import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NATIVE_HOST_BUNDLE as LIVE_HOST_BUNDLE } from "./native-host-source.ts";
import { nativeHostQualificationEnabled, QUALIFIED_NATIVE_HOST_SHA } from "./native-host-qualification.ts";

// Extract only the pinned consumer functions into an isolated VM; never execute
// the Host bundle or persist its source. Prompt generation is a synthetic input
// here: the tested property is what native consumers do with a complete blank.
test.skipIf(!nativeHostQualificationEnabled())("pinned native memory and episode consumers treat complete blank text as no changes", async () => {
  const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(QUALIFIED_NATIVE_HOST_SHA);
  const parsed = ts.createSourceFile("qualified-host.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const wanted = new Set(["parseExtractedMemories", "collectExecutorText", "summarizeEpisode", "normalizeMemoryContent", "clampLine"]);
  const selected = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) {
      expect(selected.has(node.name.text)).toBe(false); selected.set(node.name.text, node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed); expect(selected.size).toBe(wanted.size);
  const module = { exports: {} as {
    parseExtractedMemories(raw: string, prior: unknown[]): { additions: unknown[]; removals: unknown[] };
    summarizeEpisode(args: unknown): Promise<string | null>;
  } };
  runInNewContext([...selected.values()].join("\n") + "\nmodule.exports = { parseExtractedMemories, summarizeEpisode };", {
    module, MEMORY_MAX_CONTENT_LENGTH: 500, MEMORY_EXTRACTION_NONE_SENTINEL: "NONE", MEMORY_INFERENCE_PROVIDER_OPTIONS: {},
    buildEpisodeSystemPrompt: () => "synthetic input", buildEpisodeUserPrompt: () => "synthetic input",
  });
  for (const raw of ["", " \n\t", "NONE"]) expect(module.exports.parseExtractedMemories(raw, [])).toEqual({ additions: [], removals: [] });
  let streams = 0;
  const executor = { appendMessages() {}, stream() {
    streams++;
    return { fullStream: { async *[Symbol.asyncIterator]() {
      yield { type: "reasoning", textDelta: "synthetic hidden content must not become a memory" };
      yield { type: "text-delta", textDelta: " \n" };
      yield { type: "finish", reason: "stop" };
    } } };
  } };
  expect(await module.exports.summarizeEpisode({ executor, ctx: {}, turns: [{ user: "fixture", agent: "fixture" }] })).toBeNull();
  expect(streams).toBe(1);
});
