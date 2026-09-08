import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";

describe("canonicalJson", () => {
  test("keeps own __proto__ keys and does not collide with missing-key objects", () => {
    const withProto = JSON.parse('{"__proto__":{"required":"keep"},"a":1}') as { a: number };
    const encoded = canonicalJson(withProto);
    expect(encoded).toContain("__proto__");
    expect(encoded).not.toBe(canonicalJson({ a: 1 }));
    expect(sha256Text(encoded)).not.toBe(sha256Text(canonicalJson({ a: 1 })));
  });

  test("object key order is normalized; array order is semantic", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
