import { describe, expect, test } from "bun:test";
import { runWatchdogTick } from "../src/internal/roots/controller.runtime.ts";

describe("retired watchdog coordinator executor", () => {
  test("runWatchdogTick refuses without a mutation receipt", async () => {
    await expect(runWatchdogTick({
      root: "/tmp/legacy-watchdog",
      desired: { version: 1, mode: "identity" },
      models: { version: 2, models: {}, assignments: { main: null, agents: {} } },
      now: () => 0,
    })).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("legacy controller executor removed"),
    });
  });
});
