import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_VERSION, WireError } from "@grokbox/runtime-kernel/contract";
import { sameConnectionHostCompactLayer } from "../src/internal/modeld/same-connection-compact.ts";
import { modeldCompactForIncoming } from "../src/internal/roots/modeld.runtime.ts";
import { HOST_COMPACT_SYMBOL } from "../src/internal/host/profile.ts";
import { parseOverflowCanary } from "../src/internal/backends/overflow-canary.ts";
import { parseModeldRequest, parseV3Request } from "../src/internal/wire/modeld-wire.ts";

describe("normal context capability versus separately disabled fault injection", () => {
  test("normal bridge does not depend on the retired environment gate", () => {
    const previous = process.env.GROKBOX_MODELD_HOST_COMPACT;
    try {
      for (const value of [undefined, "0", "true", "1"]) {
        if (value === undefined) delete process.env.GROKBOX_MODELD_HOST_COMPACT;
        else process.env.GROKBOX_MODELD_HOST_COMPACT = value;
        expect(modeldCompactForIncoming()).toBe(sameConnectionHostCompactLayer);
      }
      expect(parseOverflowCanary({})).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GROKBOX_MODELD_HOST_COMPACT;
      else process.env.GROKBOX_MODELD_HOST_COMPACT = previous;
    }
  });
  test("wire v8 rejects every old execution peer and an unsolicited compact request", () => {
    expect(WIRE_VERSION).toBe(8);
    expect(() => parseV3Request({ version: 3, method: "health" })).toThrow(WireError);
    for (const version of [3, 4, 5, 6, 7]) expect(() => parseModeldRequest({ version, method: "health" })).toThrow(WireError);
    expect(parseModeldRequest({ version: WIRE_VERSION, method: "health" })).toEqual({ method: "health" });
    expect(() => parseModeldRequest({ version: WIRE_VERSION, method: "compact-request" })).toThrow(WireError);
  });
  test("packed preload retains scoped compact protocol and exact Host symbol", () => {
    const packed = join(import.meta.dir, "../../../dist/preload.cjs");
    expect(existsSync(packed)).toBe(true);
    const text = readFileSync(packed, "utf8");
    for (const value of ["compact-request", "resume-step", "compact_rejected", HOST_COMPACT_SYMBOL, "t21-state-root"]) expect(text).toContain(value);
    expect(createHash("sha256").update(text).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});
