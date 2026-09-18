import { expect, test } from "bun:test";
import { sha256Bytes } from "../src/hash.ts";
import { currentStateRpcRequest, decodeCurrentStateMaterial, encodeCurrentStateMaterial, type NativeMaterial } from "../src/continuity.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function material(length: number): NativeMaterial {
  const bytes = new Uint8Array(length).fill(65), hash = sha256Bytes(bytes);
  return { manifest: { version: 1, source: { agentId: id, scopeId: "b".repeat(64), contextRevision: "c".repeat(64), nativeSchema: "owned-wire", capturedAtMs: 1, transcriptThrough: null },
    quality: "native_checkpoint", root: "root", gaps: ["memory_partial", "missing_history"],
    parts: [{ id: "root", kind: "native-root", hash, bytes: length, dependencies: [] }] }, content: new Map([[hash, bytes]]) };
}
test("large bounded state payload roundtrips without recursive base64-regex stack growth", () => {
  const original = material(2 * 1024 * 1024), encoded = encodeCurrentStateMaterial(original), decoded = decodeCurrentStateMaterial(encoded);
  expect(decoded.manifest).toEqual(original.manifest);
  expect([...decoded.content.values()][0]).toEqual([...original.content.values()][0]);
  expect(encoded.content).toHaveLength(1);
});
test("noncanonical base64, duplicate objects, extra metadata and changed bytes refuse", () => {
  const encoded = encodeCurrentStateMaterial(material(1));
  for (const value of ["QQ", "QR==", "Q Q=", "Qg==", "=Q=="]) {
    expect(() => decodeCurrentStateMaterial({ ...encoded, content: [{ ...encoded.content[0], base64: value }] })).toThrow();
  }
  expect(() => decodeCurrentStateMaterial({ ...encoded, content: [encoded.content[0], encoded.content[0]] })).toThrow();
  expect(() => decodeCurrentStateMaterial({ ...encoded, path: "/arbitrary" })).toThrow();
});
test("finite current-state request never accepts session switching, missing confirm or arbitrary commands", () => {
  expect(currentStateRpcRequest({ version: 1, agentId: id, action: "head" }).action).toBe("head");
  for (const value of [{ action: "exec" }, { action: "initialize" }, { action: "activate" }, { action: "head", sessionId: "other" }]) {
    expect(() => currentStateRpcRequest({ version: 1, agentId: id, ...value })).toThrow();
  }
});
