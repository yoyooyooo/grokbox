import { describe, expect, test } from "bun:test";
import { WireError } from "@grokbox/runtime-kernel/contract";
import { decodeModeldFrame, encodeModeldFrame, parseV3Request } from "../src/internal/wire/modeld-wire.ts";

describe("modeld v3 wire", () => {
  test("round-trips health and rejects v2, extra keys, malformed utf-8", () => {
    const encoded = encodeModeldFrame({ version: 3, method: "health" });
    const decoded = decodeModeldFrame(encoded);
    expect(decoded && "value" in decoded ? parseV3Request(decoded.value) : undefined).toEqual({ method: "health" });
    expect(() => parseV3Request({ version: 2, method: "health" })).toThrow(WireError);
    expect(() => parseV3Request({ version: 3, method: "health", extra: true })).toThrow(WireError);
    const bad = Buffer.from(encoded);
    bad[5] = 0xff;
    const malformed = decodeModeldFrame(bad);
    expect(malformed && "error" in malformed ? malformed.error : undefined).toBe("malformed");
  });

  test("rejects unknown method and oversized frames", () => {
    expect(() => parseV3Request({ version: 3, method: "complete" })).toThrow(WireError);
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(9_000_000, 0);
    expect(decodeModeldFrame(huge)).toEqual({ error: "too-large" });
  });
});
