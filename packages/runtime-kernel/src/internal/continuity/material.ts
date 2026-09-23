import { canonicalJson, sha256Text } from "../../hash.ts";
import { ContinuityFailure, failContinuity, isContinuityUuid, isContinuityHash } from "./primitives.ts";
export { ContinuityFailure, failContinuity, isContinuityUuid, isContinuityHash, type ContinuityFailureCode } from "./primitives.ts";

export const CONTINUITY_MATERIAL_VERSION = 1 as const;
export const continuityId = (...parts: unknown[]): string => {
  const hash = sha256Text(canonicalJson(parts));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
export const isContinuityToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
export const continuityUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function continuityObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return failContinuity("invalid_material");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(input, key)!)) return failContinuity("invalid_material");
  }
  return input as Record<string, unknown>;
}
export type ContinuityStorePolicy = { maxObjectBytes: number; maxSnapshotBytes: number; maxPartBytes: number; maxParts: number; maxMetadataBytes: number; keepRecent: number };
/** Internal admission bounds; not a new config file, installation-wide quota,
 * execution permission, or declaration that native capture is qualified. */
export function continuityStorePolicy(input: Partial<ContinuityStorePolicy> = {}): ContinuityStorePolicy {
  const v = continuityObject(input, ["maxObjectBytes", "maxSnapshotBytes", "maxPartBytes", "maxParts", "maxMetadataBytes", "keepRecent"]);
  const defaults: ContinuityStorePolicy = { maxObjectBytes: 256 * 1024 * 1024, maxSnapshotBytes: 16 * 1024 * 1024,
    maxPartBytes: 8 * 1024 * 1024, maxParts: 128, maxMetadataBytes: 16 * 1024 * 1024, keepRecent: 2 };
  const result = { ...defaults, ...v } as ContinuityStorePolicy;
  for (const [key, value] of Object.entries(result)) if (!continuityUint(value) || value < 1 || value > defaults[key as keyof ContinuityStorePolicy] * 8) return failContinuity("invalid_material");
  if (result.keepRecent < 2 || result.keepRecent > 16 || result.maxParts > 1024 || result.maxMetadataBytes < 128 * 1024
    || result.maxMetadataBytes % 4096 || result.maxPartBytes > result.maxSnapshotBytes || result.maxSnapshotBytes > result.maxObjectBytes) return failContinuity("invalid_material");
  return Object.freeze(result);
}
export const MATERIAL_KINDS = ["native-root", "native-blob", "agent-memory", "shared-memory", "transcript", "attachment", "profile", "context-summary"] as const;
export type MaterialKind = typeof MATERIAL_KINDS[number];
export type RecoveryQuality = "native_checkpoint" | "semantic_resume" | "memory_only";
export type RecoverySource = { agentId: string; scopeId: string; contextRevision: string; nativeSchema: string; capturedAtMs: number; transcriptThrough: number | null };
export type MaterialPart = { id: string; kind: MaterialKind; hash: string; bytes: number; dependencies: string[] };
export type RecoveryManifest = { version: 1; source: RecoverySource; quality: RecoveryQuality; root: string | null; gaps: string[]; parts: MaterialPart[] };
export type RecoveryPublication = { requestId: string; manifest: RecoveryManifest; content: ReadonlyMap<string, Uint8Array> };
export const MATERIAL_GAPS = ["missing_native_root", "missing_history", "memory_partial", "unknown_effects", "source_unavailable", "unsupported_native_schema"] as const;

/** Validates the declared dependency graph and the bounded source manifest.
 * Native bytes are opaque here: native schema/semantics require the qualified
 * capture/importer. Never advertise structural validity as native acceptance. */
export function recoveryManifest(input: unknown, policy: ContinuityStorePolicy): RecoveryManifest {
  const v = continuityObject(input, ["version", "source", "quality", "root", "gaps", "parts"]);
  const s = continuityObject(v.source, ["agentId", "scopeId", "contextRevision", "nativeSchema", "capturedAtMs", "transcriptThrough"]);
  if (v.version !== 1 || !isContinuityUuid(s.agentId) || !isContinuityHash(s.scopeId) || !isContinuityToken(s.contextRevision)
    || !isContinuityToken(s.nativeSchema) || !continuityUint(s.capturedAtMs) || s.capturedAtMs === 0
    || !(s.transcriptThrough === null || continuityUint(s.transcriptThrough))
    || typeof v.quality !== "string" || !["native_checkpoint", "semantic_resume", "memory_only"].includes(v.quality)
    || !(v.root === null || isContinuityToken(v.root)) || !Array.isArray(v.gaps) || v.gaps.length > MATERIAL_GAPS.length
    || v.gaps.some(g => !MATERIAL_GAPS.includes(g)) || !Array.isArray(v.parts) || !v.parts.length || v.parts.length > policy.maxParts) return failContinuity("invalid_material");
  const parts: MaterialPart[] = v.parts.map(raw => {
    const p = continuityObject(raw, ["id", "kind", "hash", "bytes", "dependencies"]);
    if (!isContinuityToken(p.id) || !MATERIAL_KINDS.includes(p.kind as MaterialKind) || !isContinuityHash(p.hash)
      || !continuityUint(p.bytes) || p.bytes > policy.maxPartBytes || !Array.isArray(p.dependencies)
      || p.dependencies.length > policy.maxParts || p.dependencies.some(id => !isContinuityToken(id))) return failContinuity("invalid_material");
    return { id: p.id, kind: p.kind as MaterialKind, hash: p.hash, bytes: p.bytes, dependencies: [...new Set<string>(p.dependencies)].sort() };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (parts.reduce((n, p) => n + p.dependencies.length, 0) > 4096 || new TextEncoder().encode(canonicalJson(parts)).length > 256 * 1024) return failContinuity("invalid_material");
  const byId = new Map(parts.map(p => [p.id, p]));
  if (byId.size !== parts.length || parts.reduce((sum, p) => sum + p.bytes, 0) > policy.maxSnapshotBytes) return failContinuity("invalid_material");
  const hashes = new Map<string, number>();
  for (const p of parts) {
    if (hashes.has(p.hash) && hashes.get(p.hash) !== p.bytes || p.dependencies.some(id => !byId.has(id))) return failContinuity("invalid_material");
    hashes.set(p.hash, p.bytes);
  }
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) return failContinuity("invalid_material");
    if (done.has(id)) return;
    visiting.add(id); for (const next of byId.get(id)!.dependencies) visit(next);
    visiting.delete(id); done.add(id);
  };
  for (const p of parts) visit(p.id);
  if (v.root !== null && !byId.has(v.root as string)) return failContinuity("invalid_material");
  if (v.quality === "native_checkpoint" || v.quality === "semantic_resume" && byId.get(String(v.root))?.kind === "native-root") {
    if (v.root === null || byId.get(String(v.root))?.kind !== "native-root" || v.quality === "native_checkpoint" && (v.gaps.includes("missing_native_root") || v.gaps.includes("unsupported_native_schema"))) return failContinuity("invalid_material");
    const reachable = new Set<string>();
    const follow = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const next of byId.get(id)!.dependencies) follow(next); };
    follow(String(v.root));
    if (parts.some(p => ["native-root", "native-blob"].includes(p.kind) && !reachable.has(p.id))) return failContinuity("invalid_material");
  }
  if (v.quality === "semantic_resume" && (v.root === null || !(byId.get(String(v.root))?.kind === "context-summary"
    || byId.get(String(v.root))?.kind === "native-root" && byId.get("bot:context-seed")?.kind === "context-summary"))) return failContinuity("invalid_material");
  return { version: 1, source: { agentId: s.agentId, scopeId: s.scopeId, contextRevision: s.contextRevision, nativeSchema: s.nativeSchema,
    capturedAtMs: s.capturedAtMs, transcriptThrough: s.transcriptThrough as number | null }, quality: v.quality as RecoveryQuality,
    root: v.root as string | null, gaps: [...new Set<string>(v.gaps)].sort(), parts };
}
export const recoveryRevision = (manifest: RecoveryManifest) => sha256Text(canonicalJson(manifest));
export type ContinuityEffectIntent = { operationId: string; agentId: string; kind: "create" | "duplicate" | "initialize" | "activate" | "handover" | "retire";
  inputDigest: string; policyRevision: string; snapshotId: string | null };
export function continuityEffectIntent(input: unknown): ContinuityEffectIntent {
  const v = continuityObject(input, ["operationId", "agentId", "kind", "inputDigest", "policyRevision", "snapshotId"]);
  if (!isContinuityUuid(v.operationId) || !isContinuityUuid(v.agentId) || typeof v.kind !== "string" || !["create", "duplicate", "initialize", "activate", "handover", "retire"].includes(v.kind)
    || !isContinuityHash(v.inputDigest) || !isContinuityHash(v.policyRevision) || !(v.snapshotId === null || isContinuityUuid(v.snapshotId))) return failContinuity("invalid_material");
  return { operationId: v.operationId, agentId: v.agentId, kind: v.kind as ContinuityEffectIntent["kind"], inputDigest: v.inputDigest,
    policyRevision: v.policyRevision, snapshotId: v.snapshotId as string | null };
}
