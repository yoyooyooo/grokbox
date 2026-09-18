import { randomUUID, createHash } from "node:crypto";
import type { RecoveryPublication, RecoveryQuality, MaterialKind } from "@grokbox/runtime-kernel/continuity";

export const CONT_SCOPE = "a".repeat(64);
export const CONT_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CONT_POLICY = "b".repeat(64);
export const byteHash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
/** Synthetic opaque bytes exercise persistence, not private native decoding. */
export function materialFixture(label = "original", at = Date.now(), quality: RecoveryQuality = "native_checkpoint"): RecoveryPublication {
  const raw: Array<{ id: string; kind: MaterialKind; value: string; dependencies: string[] }> = [
    { id: "root-slot", kind: quality === "native_checkpoint" ? "native-root" : "context-summary", value: `SYNTHETIC_ROOT:${label}`, dependencies: ["message"] },
    { id: "message", kind: quality === "native_checkpoint" ? "native-blob" : "transcript", value: `USER_FACT:${label}`, dependencies: [] },
    { id: "memory", kind: "agent-memory", value: "STABLE_MEMORY_SENTINEL", dependencies: [] },
  ];
  const content = new Map<string, Uint8Array>();
  const parts = raw.map(p => { const data = new TextEncoder().encode(p.value), hash = byteHash(data); content.set(hash, data);
    return { id: p.id, kind: p.kind, hash, bytes: data.byteLength, dependencies: p.dependencies }; });
  return { requestId: randomUUID(), manifest: { version: 1, source: { agentId: CONT_AGENT, scopeId: CONT_SCOPE,
    contextRevision: "same-slot-not-a-version", nativeSchema: "owned-synthetic-v1", capturedAtMs: at, transcriptThrough: 7 },
    quality, root: quality === "memory_only" ? null : "root-slot", gaps: quality === "native_checkpoint" ? [] : ["missing_native_root"], parts }, content };
}
