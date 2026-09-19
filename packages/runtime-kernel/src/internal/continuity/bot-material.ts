import { canonicalJson, sha256Bytes, sha256Text } from "../../hash.ts";
import { continuityObject, continuityUint, failContinuity, isContinuityUuid, continuityStorePolicy, type MaterialPart } from "./material.ts";
import { copyNativeMaterial, type NativeMaterial } from "./current-state.ts";

export const BOT_MATERIAL_LIMIT = 2 * 1024 * 1024;
export const BOT_MEMORY_LIMIT = 256;
export const BOT_HISTORY_LIMIT = 512;
export type BotMemory = { content: string; createdAt: number; kind: "profile" | "log" };
export type BotSupplement = { version: 1; sourceId: string; memory: BotMemory[]; history: Record<string, unknown>[];
  memoryComplete: boolean; historyComplete: boolean; instructions?: string };
const text = (value: unknown, max = 65536) => {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) return failContinuity("invalid_material");
  return value;
};
function data(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): unknown {
  if (++budget.nodes > 16384 || depth > 12) return failContinuity("invalid_material");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const result = text(value); budget.bytes += new TextEncoder().encode(result).byteLength;
    if (budget.bytes > BOT_MATERIAL_LIMIT) return failContinuity("invalid_material");
    return result;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1024) return failContinuity("invalid_material");
    return value.map(v => data(v, depth + 1, budget));
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return failContinuity("invalid_material");
  const result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(value).length > 64) return failContinuity("invalid_material");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) return failContinuity("invalid_material");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) return failContinuity("invalid_material");
    if (descriptor.value !== undefined) result[key] = data(descriptor.value, depth + 1, budget);
  }
  return result;
}
export function botSupplement(raw: unknown): BotSupplement {
  const v = continuityObject(raw, ["version", "sourceId", "memory", "history", "memoryComplete", "historyComplete", "instructions"]);
  if (v.version !== 1 || !isContinuityUuid(v.sourceId) || !Array.isArray(v.memory) || v.memory.length > BOT_MEMORY_LIMIT
    || !Array.isArray(v.history) || v.history.length > BOT_HISTORY_LIMIT || typeof v.memoryComplete !== "boolean" || typeof v.historyComplete !== "boolean") return failContinuity("invalid_material");
  const memory = v.memory.map(raw => {
    const m = continuityObject(raw, ["content", "createdAt", "kind"]);
    if (!continuityUint(m.createdAt) || !["profile", "log"].includes(String(m.kind))) return failContinuity("invalid_material");
    return { content: text(m.content), createdAt: m.createdAt, kind: m.kind as BotMemory["kind"] };
  });
  const seen = new Set<string>();
  const budget = { nodes: 0, bytes: 0 };
  const history = v.history.map(raw => {
    const entry = data(raw, 0, budget) as Record<string, unknown>;
    if (!entry || Array.isArray(entry) || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.length > 512
      || typeof entry.kind !== "string" || !["message", "send-message", "notice", "tool-call", "user-attachment"].includes(entry.kind)
      || !continuityUint(entry.timestampMs) || seen.has(entry.id)) return failContinuity("invalid_material");
    if (entry.kind === "send-message" && (entry.message as any)?.type !== "text") return failContinuity("invalid_material");
    seen.add(entry.id); return entry;
  });
  const result: BotSupplement = { version: 1, sourceId: v.sourceId, memory, history, memoryComplete: v.memoryComplete, historyComplete: v.historyComplete,
    ...(v.instructions === undefined ? {} : { instructions: text(v.instructions, 65536) }) };
  if (new TextEncoder().encode(canonicalJson(result)).byteLength > BOT_MATERIAL_LIMIT) return failContinuity("invalid_material");
  return result;
}
export function appendBotSupplement(material: NativeMaterial, raw: BotSupplement): NativeMaterial {
  const supplement = botSupplement(raw), base = copyNativeMaterial(material, continuityStorePolicy());
  if (supplement.sourceId !== base.manifest.source.agentId || base.manifest.parts.some(p => p.id === "bot:supplement")) return failContinuity("invalid_material");
  const bytes = new TextEncoder().encode(canonicalJson(supplement)), hash = sha256Bytes(bytes);
  const parts = [...base.manifest.parts, { id: "bot:supplement", kind: "agent-memory" as const, hash, bytes: bytes.byteLength, dependencies: [] }];
  const gaps = base.manifest.gaps.filter(g => g !== "memory_partial" || !supplement.memoryComplete).filter(g => g !== "missing_history" || !supplement.historyComplete);
  return copyNativeMaterial({ manifest: { ...base.manifest, parts, gaps }, content: new Map([...base.content, [hash, bytes]]) }, continuityStorePolicy());
}
export function readBotSupplement(material: NativeMaterial): BotSupplement | null {
  const parts = material.manifest.parts.filter(p => p.id === "bot:supplement");
  if (!parts.length) return null;
  if (parts.length !== 1 || parts[0]!.kind !== "agent-memory" || parts[0]!.bytes > BOT_MATERIAL_LIMIT) return failContinuity("invalid_material");
  const bytes = material.content.get(parts[0]!.hash);
  if (!bytes || sha256Bytes(bytes) !== parts[0]!.hash) return failContinuity("integrity_failure");
  const value = botSupplement(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (value.sourceId !== material.manifest.source.agentId) return failContinuity("scope_mismatch");
  return value;
}
export const nativeMaterialParts = (parts: readonly MaterialPart[]) => parts.filter(p => p.kind === "native-root" || p.kind === "native-blob");

/** Explicit lower-quality source bundle for a Temporal/uncapturable source.
 * Keeps exact selected history/Memory as evidence, never invents a native root. */
export function materialFromBotSupplement(raw: BotSupplement, source: NativeMaterial["manifest"]["source"]): NativeMaterial {
  const supplement = botSupplement(raw);
  if (supplement.sourceId !== source.agentId) return failContinuity("scope_mismatch");
  const bytes = new TextEncoder().encode(canonicalJson(supplement)), hash = sha256Bytes(bytes);
  return copyNativeMaterial({ manifest: { version: 1, source, quality: "memory_only", root: null,
    gaps: ["missing_native_root", ...(supplement.memoryComplete ? [] : ["memory_partial"]), ...(supplement.historyComplete ? [] : ["missing_history"])],
    parts: [{ id: "bot:supplement", kind: "agent-memory", hash, bytes: bytes.length, dependencies: [] }] }, content: new Map([[hash, bytes]]) }, continuityStorePolicy());
}

export function replaceSupplementInstructions(raw: NativeMaterial, instructions: string): NativeMaterial {
  const material = copyNativeMaterial(raw, continuityStorePolicy()), original = readBotSupplement(material);
  if (!original) return failContinuity("invalid_material");
  const next = botSupplement({ ...original, instructions }), bytes = new TextEncoder().encode(canonicalJson(next)), hash = sha256Bytes(bytes);
  const part = material.manifest.parts.find(p => p.id === "bot:supplement")!;
  const parts=material.manifest.parts.map(p => p === part ? { ...p, hash, bytes: bytes.length } : p);
  const content=new Map(material.content);content.set(hash,bytes);
  for(const key of content.keys())if(!parts.some(p=>p.hash===key))content.delete(key);
  return copyNativeMaterial({ manifest: { ...material.manifest, parts }, content }, continuityStorePolicy());
}
export function importedHistory(supplement: BotSupplement, targetId: string): Record<string, unknown>[] {
  if (!isContinuityUuid(targetId)) return failContinuity("invalid_material");
  const mapped = new Map(supplement.history.map(e => [String(e.id), `grokbox-import:${sha256Text(canonicalJson([targetId, supplement.sourceId, e.id]))}`]));
  return supplement.history.map(entry => {
    const result = { ...entry, id: mapped.get(String(entry.id))!, continuitySource: { agentId: supplement.sourceId, entryId: entry.id, historical: true } } as Record<string, unknown>;
    if (typeof entry.rootId === "string") {
      if (mapped.has(entry.rootId)) result.rootId = mapped.get(entry.rootId)!;
      else delete result.rootId;
    }
    return result;
  });
}
