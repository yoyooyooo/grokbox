import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runManualReadopt, runWatchdogTick } from "../src/internal/roots/controller.runtime.ts";

const desired = { version: 1 as const, mode: "identity" as const };
const models = { version: 3 as const, models: {}, assignments: { main: null, agents: {} } };

describe("retired manual re-adopt executor", () => {
  test("unconfirmed calls still require --confirm; confirmed calls are removed", async () => {
    const input = { root: "/tmp/legacy-manual", desired, models, now: () => 0, confirmed: false as const };
    await expect(runManualReadopt(input)).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("--confirm"),
    });
    await expect(runManualReadopt({ ...input, confirmed: true })).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("legacy controller executor removed"),
    });
    await expect(runWatchdogTick(input)).rejects.toMatchObject({ code: "invalid_usage" });
  });

  test("source no longer delegates confirmed apply to a watchdog tick body", async () => {
    const src = await readFile(new URL("../src/internal/roots/controller.runtime.ts", import.meta.url), "utf8");
    expect(src).toContain("export async function runManualReadopt");
    expect(src).not.toMatch(/return await runWatchdogTick\(input\)/);
    expect(src).not.toContain("legacyWitness");
  });
});
