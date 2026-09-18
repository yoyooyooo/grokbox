import { expect, test } from "bun:test";
import { continuityEffectIntent, continuityStorePolicy, recoveryManifest, recoveryRevision } from "../src/continuity.ts";

const H = "a".repeat(64), A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function manifest() { return { version: 1, source: { agentId: A, scopeId: H, contextRevision: "fixed-slot", nativeSchema: "owned-fixture", capturedAtMs: 1, transcriptThrough: null },
  quality: "native_checkpoint", root: "root", gaps: [], parts: [
    { id: "root", kind: "native-root", hash: H, bytes: 4, dependencies: ["message"] },
    { id: "message", kind: "native-blob", hash: "b".repeat(64), bytes: 4, dependencies: [] },
  ] }; }

test("material revision is content-bound and independent of input ordering, not an opaque root slot ID", () => {
  const p = continuityStorePolicy(), a = recoveryManifest(manifest(), p);
  const b = recoveryManifest({ ...manifest(), parts: [...manifest().parts].reverse() }, p);
  expect(recoveryRevision(a)).toBe(recoveryRevision(b));
  const c = manifest(); c.parts[0]!.hash = "c".repeat(64);
  expect(recoveryRevision(a)).not.toBe(recoveryRevision(recoveryManifest(c, p)));
});

test("manifest and operation parsing do not evaluate getters or enum coercion", () => {
  let calls = 0;
  expect(() => recoveryManifest({ ...manifest(), quality: { toString: () => { calls++; return "native_checkpoint"; } } }, continuityStorePolicy())).toThrow();
  expect(() => recoveryManifest(Object.defineProperty(manifest(), "root", { get: () => { calls++; return "root"; } }), continuityStorePolicy())).toThrow();
  expect(() => continuityEffectIntent({ operationId: A, agentId: A, kind: { toString: () => { calls++; return "create"; } }, inputDigest: H, policyRevision: H, snapshotId: null })).toThrow();
  expect(calls).toBe(0);
});

test("unknown fields, cycles and native parts outside the declared root closure are rejected", () => {
  const p = continuityStorePolicy();
  expect(() => recoveryManifest({ ...manifest(), secret: "not a manifest field" }, p)).toThrow();
  const cycle = manifest(); cycle.parts[1]!.dependencies = ["root"];
  expect(() => recoveryManifest(cycle, p)).toThrow();
  const orphan = manifest(); orphan.parts.push({ id: "orphan", kind: "native-blob", hash: "d".repeat(64), bytes: 1, dependencies: [] });
  expect(() => recoveryManifest(orphan, p)).toThrow();
});

test("best-effort material remains a separate declared quality and cannot silently pass as native", () => {
  const input = manifest(); input.quality = "semantic_resume"; input.parts[0]!.kind = "context-summary"; input.parts[1]!.kind = "transcript";
  const material = recoveryManifest({ ...input, gaps: ["missing_native_root", "unknown_effects"] }, continuityStorePolicy());
  expect(material.quality).toBe("semantic_resume"); expect(material.gaps).toContain("unknown_effects");
  expect(() => recoveryManifest({ ...material, quality: "native_checkpoint" }, continuityStorePolicy())).toThrow();
});

test("bounded policy keeps at least two points and rejects incompatible or non-numeric budgets", () => {
  expect(continuityStorePolicy().keepRecent).toBe(2);
  for (const value of [{ keepRecent: 1 }, { maxParts: 0 }, { maxMetadataBytes: 12345 }, { maxSnapshotBytes: 1 }, { maxParts: "128" }, { permission: "create" }]) {
    expect(() => continuityStorePolicy(value as never)).toThrow();
  }
});
