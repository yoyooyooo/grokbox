import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BOT_HISTORY_LIMIT, BOT_MEMORY_LIMIT, BOT_MATERIAL_LIMIT, botSupplement, importedHistory,
  CurrentStateFailure, type BotSupplement, type BotMemory } from "@grokbox/runtime-kernel/continuity";

export type NativeBotMaterialOwner = {
  memory: { listMemories: (limit: number) => unknown[]; countMemories: () => number;
    addMemory: (content: string, at: number, kind: "profile" | "log") => unknown };
  history: { getTranscriptTail: (query: { limit: number }) => { entries: unknown[] };
    getEntryById: (id: string) => unknown; appendTranscriptEntries: (entries: unknown[]) => boolean };
};
const fail = (): never => { throw new CurrentStateFailure("material_invalid"); };
const normalized = (content: string) => content.replace(/\r\n/g, "\n").trim();
export function captureNativeBotSupplement(sourceId: string, owner: NativeBotMaterialOwner): BotSupplement {
  const all = owner.memory.listMemories(BOT_MEMORY_LIMIT + 1), count = owner.memory.countMemories();
  const raw = owner.history.getTranscriptTail({ limit: BOT_HISTORY_LIMIT + 1 }).entries;
  if (!Array.isArray(all) || !Array.isArray(raw) || !Number.isSafeInteger(count) || count < 0) return fail();
  let memoryComplete = count <= BOT_MEMORY_LIMIT && all.length <= BOT_MEMORY_LIMIT, historyComplete = raw.length <= BOT_HISTORY_LIMIT;
  const memory: BotMemory[] = [], history: Record<string, unknown>[] = [];
  let used = 1024;
  for (const value of all.slice(0, BOT_MEMORY_LIMIT)) {
    try {
      const v = value as any;
      const record = botSupplement({ version: 1, sourceId, memory: [{ content: v.content, createdAt: v.createdAt, kind: v.kind }], history: [], memoryComplete: false, historyComplete: false }).memory[0]!;
      used += new TextEncoder().encode(canonicalJson(record)).byteLength;
      if (used > BOT_MATERIAL_LIMIT / 2) { memoryComplete = false; break; }
      memory.push(record);
    } catch { memoryComplete = false; }
  }
  for (const value of raw.slice(-BOT_HISTORY_LIMIT)) {
    try {
      const record = botSupplement({ version: 1, sourceId, memory: [], history: [value], memoryComplete: false, historyComplete: false }).history[0]!;
      used += new TextEncoder().encode(canonicalJson(record)).byteLength;
      if (used > BOT_MATERIAL_LIMIT - 4096) { historyComplete = false; break; }
      history.push(record);
    } catch { historyComplete = false; }
  }
  return botSupplement({ version: 1, sourceId, memory, history, memoryComplete, historyComplete });
}
export type SupplementReceipt = { version: 1; sourceId: string; memory: string[]; history: Array<{ id: string; hash: string }> };
export function applyNativeBotSupplement(targetId: string, raw: BotSupplement, owner: NativeBotMaterialOwner): SupplementReceipt {
  const supplement = botSupplement(raw), imported = importedHistory(supplement, targetId);
  const requirements = { version: 1 as const, sourceId: supplement.sourceId,
    memory: supplement.memory.map(m => sha256Text(normalized(m.content))),
    history: imported.map(entry => ({ id: String(entry.id), hash: sha256Text(canonicalJson(entry)) })) };
  for (let i = 0; i < imported.length; i++) {
    const prior = owner.history.getEntryById(String(imported[i]!.id));
    if (prior != null && sha256Text(canonicalJson(prior)) !== requirements.history[i]!.hash) return fail();
  }
  for (const memory of supplement.memory) owner.memory.addMemory(memory.content, memory.createdAt, memory.kind);
  if (!owner.history.appendTranscriptEntries(imported)) throw new CurrentStateFailure("commit_unknown");
  verifyNativeBotSupplement(requirements, owner);
  return requirements;
}
export function verifyNativeBotSupplement(receipt: SupplementReceipt, owner: NativeBotMaterialOwner): void {
  if (receipt?.version !== 1 || !Array.isArray(receipt.memory) || receipt.memory.length > BOT_MEMORY_LIMIT
    || !Array.isArray(receipt.history) || receipt.history.length > BOT_HISTORY_LIMIT) return fail();
  const memories = owner.memory.listMemories(BOT_MEMORY_LIMIT * 2);
  if (!Array.isArray(memories)) return fail();
  const hashes = new Set(memories.map((m: any) => typeof m?.content === "string" ? sha256Text(normalized(m.content)) : ""));
  if (receipt.memory.some(hash => !hashes.has(hash))) throw new CurrentStateFailure("commit_unknown");
  for (const expected of receipt.history) {
    const actual = owner.history.getEntryById(expected.id);
    if (actual == null || sha256Text(canonicalJson(actual)) !== expected.hash) throw new CurrentStateFailure("commit_unknown");
  }
}
