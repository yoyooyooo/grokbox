import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Option } from "effect";
import { HostCompact } from "@grokbox/runtime-kernel/ports";
import { modeldHostCompactEnabled, modeldRootLayer } from "../src/internal/roots/modeld.runtime.ts";

describe("production modeld root", () => {
  test("HostCompact gate is off unless GROKBOX_MODELD_HOST_COMPACT=1", () => {
    expect(modeldHostCompactEnabled({})).toBe(false);
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "true" })).toBe(false);
    expect(modeldHostCompactEnabled({ GROKBOX_MODELD_HOST_COMPACT: "1" })).toBe(true);
  });

  test("does not provide HostCompact", async () => {
    const layer = modeldRootLayer({
      durableRoot: mkdtempSync(join(tmpdir(), "grokbox-hc-")),
      runRoot: mkdtempSync(join(tmpdir(), "grokbox-hr-")),
      env: {},
      serviceEpoch: "probe",
    });
    const present = await Effect.runPromise(Effect.gen(function* () {
      const ctx = yield* Effect.context<never>();
      return Option.isSome(Context.getOption(ctx as Context.Context<HostCompact>, HostCompact));
    }).pipe(Effect.provide(layer), Effect.scoped));
    expect(present).toBe(false);
  });
});
