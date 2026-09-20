import { describe, expect, test } from "bun:test";
import { runWatchdogCutover, runWatchdogTick } from "../src/internal/roots/controller.runtime.ts";

describe("retired watchdog cutover executor", () => {
  test("cutover and tick both refuse", async () => {
    const input = {
      root: "/tmp/legacy-cutover",
      desired: { version: 1 as const, mode: "identity" as const },
      models: { version: 3 as const, models: {}, assignments: { main: null, agents: {} } },
      now: () => 0,
    };
    await expect(runWatchdogCutover(input)).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(runWatchdogTick(input)).rejects.toMatchObject({ code: "invalid_usage" });
  });
});
