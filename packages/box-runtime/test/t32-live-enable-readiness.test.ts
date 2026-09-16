import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Option } from "effect";
import { WIRE_VERSION, WireError } from "@grokbox/runtime-kernel/contract";
import { HostCompact } from "@grokbox/runtime-kernel/ports";
import { sameConnectionHostCompactLayer } from "../src/internal/modeld/same-connection-compact.ts";
import {
  modeldCompactForIncoming,
  modeldHostCompactEnabled,
  modeldRootLayer,
} from "../src/internal/roots/modeld.runtime.ts";
import { HOST_COMPACT_SYMBOL } from "../src/internal/host/profile.ts";
import { parseOverflowCanary } from "../src/internal/backends/overflow-canary.ts";
import { parseModeldRequest, parseV3Request } from "../src/internal/wire/modeld-wire.ts";

delete process.env.GROKBOX_MODELD_HOST_COMPACT;
delete process.env.GROKBOX_MODELD_OVERFLOW_CANARY_AGENT;
delete process.env.GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS;
delete process.env.GROKBOX_CONTEXT_CAP;
delete process.env.GROKBOX_ALLOW_LIVE_HOST;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("T32 live-enable readiness (default-off; opt-in env=1)", () => {
  test("default-off: unset/true/0 keep HostCompact detached", async () => {
    expect(modeldHostCompactEnabled()).toBe(false);
    expect(modeldHostCompactEnabled({})).toBe(false);
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "true" })).toBe(false);
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "0" })).toBe(false);
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "" })).toBe(false);
    expect(modeldCompactForIncoming()).toBeUndefined();
    expect(modeldCompactForIncoming({})).toBeUndefined();
    expect(modeldCompactForIncoming({ GROKBOX_MODELD_HOST_COMPACT: "true" })).toBeUndefined();
    expect(modeldCompactForIncoming({ GROKBOX_MODELD_HOST_COMPACT: "0" })).toBeUndefined();
    expect(parseOverflowCanary()).toBeUndefined();
    expect(parseOverflowCanary({})).toBeUndefined();
    const layer = modeldRootLayer({
      durableRoot: mkdtempSync(join(tmpdir(), "grokbox-ready-d-")),
      runRoot: mkdtempSync(join(tmpdir(), "grokbox-ready-r-")),
      env: { GROKBOX_MODELD_HOST_COMPACT: "1" },
      serviceEpoch: "probe",
    });
    const present = await Effect.runPromise(Effect.gen(function* () {
      const ctx = yield* Effect.context<never>();
      return Option.isSome(Context.getOption(ctx as Context.Context<HostCompact>, HostCompact));
    }).pipe(Effect.provide(layer), Effect.scoped));
    expect(present).toBe(false);
  });

  test("opt-in wiring: env=1 attaches sameConnectionHostCompactLayer only", () => {
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "1" })).toBe(true);
    expect(modeldCompactForIncoming({ GROKBOX_MODELD_HOST_COMPACT: "1" })).toBe(sameConnectionHostCompactLayer);
  });

  test("omitted env follows process.env exact-1 only", () => {
    const previous = process.env.GROKBOX_MODELD_HOST_COMPACT;
    try {
      process.env.GROKBOX_MODELD_HOST_COMPACT = "1";
      expect(modeldHostCompactEnabled()).toBe(true);
      expect(modeldCompactForIncoming()).toBe(sameConnectionHostCompactLayer);
      expect(modeldHostCompactEnabled({})).toBe(false);
      process.env.GROKBOX_MODELD_HOST_COMPACT = "true";
      expect(modeldHostCompactEnabled()).toBe(false);
      expect(modeldCompactForIncoming()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GROKBOX_MODELD_HOST_COMPACT;
      else process.env.GROKBOX_MODELD_HOST_COMPACT = previous;
    }
  });

  test("wire is v5; old peers and initial compact-request are rejected", () => {
    expect(WIRE_VERSION).toBe(5);
    expect(() => parseV3Request({ version: 3, method: "health" })).toThrow(WireError);
    expect(() => parseModeldRequest({ version: 3, method: "health" })).toThrow(WireError);
    expect(() => parseModeldRequest({ version: 4, method: "health" })).toThrow(WireError);
    expect(parseModeldRequest({ version: 5, method: "health" })).toEqual({ method: "health" });
    expect(() => parseModeldRequest({ version: 5, method: "compact-request" })).toThrow(WireError);
  });

  test("packed preload still contains Host compact-request client and D2 register symbol", () => {
    const packed = join(repoRoot, "dist", "preload.cjs");
    expect(existsSync(packed)).toBe(true);
    const text = readFileSync(packed, "utf8");
    expect(text).toContain("compact-request");
    expect(text).toContain("resume-step");
    expect(text).toContain("compact_rejected");
    expect(text).toContain(HOST_COMPACT_SYMBOL);
    expect(text).not.toContain("= bindHostCompactHook();");
    expect(text).toContain("t21-state-root");
    const sha = createHash("sha256").update(readFileSync(packed)).digest("hex");
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });
});
