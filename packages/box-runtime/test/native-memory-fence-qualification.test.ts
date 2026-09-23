import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { createNativeCurrentStateOwner, NATIVE_CURRENT_STATE_KEY } from "../src/internal/host/native-current-state-owner.ts";
import { nativeContinuityPair } from "./native-continuity-pair.ts";

const pair = nativeContinuityPair(process.env), nativeTest = test.skipIf(process.env.GROKBOX_TEST_NATIVE_CONTINUITY !== "1");
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId = "e".repeat(64);
/** A negative capability qualification, not a self-reset success test. The
 * original selected Memory writer still crosses the separate current-state
 * hold. A producer fix must replace this counterexample with a positive proof.
 * No real account, Provider, registered service or native data directory is used. */
function selectedNative() {
  const source = readFileSync("/home/box/sand-host/host-main.cjs", "utf8");
  expect(sha256Text(source)).toBe(pair.host);
  const hashes: Record<string, string> = {};
  const selected = (name: string, code: string) => { hashes[name] = sha256Text(code); return code; };
  const fn = (name: string, async = false) => {
    const marker = `\n${async ? "async " : ""}function ${name}(`, start = source.indexOf(marker), end = source.indexOf("\n}", start);
    if (start < 0 || source.indexOf(marker, start + 1) >= 0 || end < 0 || end - start > 32768) throw Error("native_memory_function_changed");
    const code = source.slice(start + 1, end + 2), ast = ts.createSourceFile("native-function.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.statements.length !== 1 || !ts.isFunctionDeclaration(ast.statements[0]!) || ast.statements[0]!.name?.text !== name) throw Error("native_memory_function_invalid");
    return selected(name, code);
  };
  const marker = "var FileMemoryStore = class {", start = source.indexOf(marker), end = source.indexOf("\n};", start);
  if (start < 0 || source.indexOf(marker, start + 1) >= 0 || end < 0 || end - start > 65536) throw Error("native_memory_class_changed");
  const ast = ts.createSourceFile("native-memory.js", source.slice(start, end + 3), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decl = (ast.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer;
  if (!decl || !ts.isClassExpression(decl)) throw Error("native_memory_class_invalid");
  const matches = decl.members.filter(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === "addMemory");
  if (matches.length !== 1) throw Error("native_memory_writer_ambiguous");
  return { addMemory: selected("FileMemoryStore.addMemory", matches[0]!.getText(ast)),
    extraction: fn("runMemoryExtraction", true), apply: fn("applyExtractedMemories"), hashes };
}
function holdOwner() {
  const qualification = { hostSourceSha: pair.host, nativeSchema: pair.schema }, kv = new Map<string, string>();
  const owner = createNativeCurrentStateOwner({ qualification, generation: "isolated-native-memory-fence" });
  const store = { getMetadata: () => new Uint8Array(), getConversationStateStructure: () => ({ toBinary: () => new Uint8Array(), pendingToolCalls: [] }),
    resetFromDb: async () => undefined, getBlobStore: () => ({ grokboxCurrentState: async () => { throw Error("unused-worker-port"); } }) };
  const metadata = { readKv: (key: string) => kv.get(key) ?? null, writeKv: (key: string, value: string) => { kv.set(key, value); return true; },
    compareAndSetLatestRootBlobId: () => false, getTranscriptTail: () => ({ entries: [] }), getPendingAutomationCompletions: () => [] };
  const registration = { store, metadata, ctx: {}, rootId: new Uint8Array(), source: qualification, valid: () => true };
  owner.register(agentId, registration);
  return { owner, registration, store, metadata,
    prepare: async () => {
      const operationId = randomUUID();
      await owner.withBirth({ operationId, scopeId, profile: { name: "Synthetic", description: "", title: "", avatarShape: "", avatarColor: "" }, instructions: "" },
        async () => { owner.stageBirth(agentId, operationId); });
      expect(JSON.parse(metadata.readKv(NATIVE_CURRENT_STATE_KEY)!)).toMatchObject({ hold: "prepared" });
    } };
}
function memoryFixture(code: ReturnType<typeof selectedNative>) {
  const root = mkdtempSync(join(tmpdir(), "grokbox-memory-fence-")), file = join(root, "profile.md");
  const Writer = runInNewContext(`(class { ${code.addMemory} })`, {
    normalizeMemoryContent: (s: string) => s.trim(), memoryDedupeKey: (s: string) => s.trim().toLowerCase(),
    memoryIdFor: sha256Text, PROFILE_HEADER: "# Synthetic memory\n", LOG_HEADER: "# Synthetic log\n",
    serializeFactLine: (content: string, createdAt: number) => JSON.stringify({ content, createdAt }),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const writer = new Writer();
  // Native method and control flow; normalization/serialization and IO adapters
  // are deliberately finite test doubles. The file bytes are genuinely written
  // only below this fresh test-owned directory, not a native memory store.
  writer.profileFile = file; writer.allFacts = () => []; writer.recall = () => ({ profile: [], recent: [] }); writer.listMemories = () => [];
  writer.read = (path: string) => { if (path !== file) throw Error("test-path-escape"); return existsSync(file) ? readFileSync(file, "utf8") : ""; };
  writer.writeAtomic = (path: string, content: string) => { if (path !== file) throw Error("test-path-escape"); writeFileSync(file, content, { mode: 0o600 }); };
  return { writer, exists: () => existsSync(file), read: () => readFileSync(file, "utf8"), close: () => rmSync(root, { recursive: true, force: true }) };
}

nativeTest("current native Memory writer is outside the current-state preparation hold", async () => {
  const code = selectedNative(), current = holdOwner(), memory = memoryFixture(code);
  try {
    await current.prepare();
    expect(() => current.owner.enter(agentId)).toThrow("not_prepared");
    let checkpoints = 0;
    await expect(current.owner.checkpoint(agentId, async () => { checkpoints++; }, current.store)).rejects.toThrow("not_prepared");
    expect(checkpoints).toBe(0);
    const head = current.owner.readHead(agentId, scopeId);
    memory.writer.addMemory("SYNTHETIC_OLD_MEMORY", 1, "profile");
    expect(memory.read()).toContain("SYNTHETIC_OLD_MEMORY");
    expect(current.owner.readHead(agentId, scopeId)).toEqual(head);
    console.log(JSON.stringify({ qualification: "AH-139-memory-fence-gap", hostSha: pair.host, selectedHashes: code.hashes,
      turnBlocked: true, checkpointBlocked: true, memoryWriteCrossedHold: true, currentRevisionChanged: false, selfResetQualified: false, liveAccountEffects: false }));
  } finally { memory.close(); }
});

nativeTest("original asynchronous extraction resumes across a new hold and reaches its original Memory writer", async () => {
  const code = selectedNative(), current = holdOwner(), memory = memoryFixture(code);
  let release!: (value: unknown) => void, reached!: () => void;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  const run = runInNewContext(`${code.apply}\n${code.extraction}\nrunMemoryExtraction`, {
    memoryDedupeKey: (s: string) => s.trim().toLowerCase(), gatherExtractionMemories: () => [],
    MEMORY_RECENT_PROMPT_LIMIT: 1, MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT: 1,
    extractMemories: async () => { reached(); return gate; }, errorLogTag: () => "synthetic", process: { stderr: { write: () => { throw Error("native-extraction-failed"); } } },
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  try {
    const task = run(memory.writer, { getExecutor: () => ({ synthetic: true }) }, {}, { user: "SYNTHETIC_INPUT", agent: "SYNTHETIC_OUTPUT" });
    await entered; expect(memory.exists()).toBe(false); await current.prepare();
    const head = current.owner.readHead(agentId, scopeId);
    release({ removals: [], additions: [{ content: "SYNTHETIC_LATE_MEMORY", kind: "profile" }] }); await task;
    expect(memory.read()).toContain("SYNTHETIC_LATE_MEMORY"); expect(current.owner.readHead(agentId, scopeId)).toEqual(head);
    console.log(JSON.stringify({ qualification: "AH-139-late-memory-gap", hostSha: pair.host, selectedHashes: code.hashes,
      originalExtractionAwaited: true, holdEstablishedBeforeResult: true, lateWriteCrossedHold: true,
      currentRevisionChanged: false, selfResetQualified: false, liveAccountEffects: false }));
  } finally { release({ removals: [], additions: [] }); memory.close(); }
});
