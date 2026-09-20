import { describe, expect, test } from "bun:test";
import { runManualReadopt } from "../src/internal/roots/controller.runtime.ts";

describe("retired compile-receipt coordinator path", () => {
  test("manual readopt cannot commit a compile receipt", async () => {
    await expect(runManualReadopt({
      confirmed: true,
      root: "/tmp/legacy-compile",
      desired: { version: 1, mode: "route" },
      models: { version: 3, models: {}, assignments: { main: { modelId: "stub/echo" }, agents: {} } },
      now: () => 0,
    })).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("legacy controller executor removed"),
    });
  });
});
