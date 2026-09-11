import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runManualReadopt,
  runWatchdogCutover,
  runWatchdogTick,
} from "../src/internal/roots/controller.runtime.ts";
import { createLiveH3AdoptPorts } from "../src/internal/process/h3-live.ts";
import { SOURCE } from "./admission-fixture.ts";

const input = {
  root: "/tmp/legacy-admission",
  desired: { version: 1 as const, mode: "identity" as const },
  models: { version: 1 as const, models: {}, assignments: { main: null, agents: {} } },
  now: () => 0,
};

describe("retired first-signal coordinator admission", () => {
  test("manual/tick/cutover executors refuse", async () => {
    await expect(runManualReadopt({ ...input, confirmed: true })).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(runWatchdogTick(input)).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(runWatchdogCutover(input)).rejects.toMatchObject({ code: "invalid_usage" });
  });

  test("H3 source facts cannot silently hash replacement characters for invalid UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-h3-encoding-"));
    const copy = join(root, "invalid-synthetic.cjs");
    await writeFile(copy, Buffer.concat([Buffer.from(SOURCE), Buffer.from([0xff])]));
    const target = createLiveH3AdoptPorts({
      markerPath: join(root, "marker.json"),
      overlayPath: join(root, "launch.json"),
      preloadNeedle: "/fixture/preload.cjs",
      execPath: process.execPath,
      hostBundle: copy,
    }).target!;
    expect(() => target.readSource()).toThrow("unsupported-host-encoding");
  });
});
