import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runIdentityChainInject,
  runLiveIdentityDeactivate,
  runLiveIdentityInject,
} from "../src/internal/process/live-inject.ts";
import {
  runManualReadopt,
  runWatchdogCutover,
  runWatchdogTick,
} from "../src/internal/roots/controller.runtime.ts";
import { FakeProcessTree } from "./fake-tree.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const boxSrc = join(repoRoot, "packages/box-runtime/src");
const cliSrc = join(repoRoot, "packages/cli/src");

const EXECUTOR_NAMES = [
  "runWatchdogTick",
  "runWatchdogCutover",
  "runManualReadopt",
  "runLiveIdentityInject",
  "runLiveIdentityDeactivate",
  "runIdentityChainInject",
  "LegacyWitness",
  "runWatchdogTickBody",
  "legacyWitness",
];

const desired = { version: 1 as const, mode: "observe" as const };
const models = { version: 3 as const, models: {}, assignments: { main: null, agents: {} } };

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const names = await readdir(dir, { withFileTypes: true });
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

describe("T28 P2-01 legacy executors removed", () => {
  test("production CLI and control composition do not import retired executors", async () => {
    const files = [
      ...(await walk(cliSrc)),
      join(boxSrc, "runtime.ts"),
      join(boxSrc, "preload.ts"),
      join(boxSrc, "internal/roots/controller-program.node.ts"),
      join(boxSrc, "internal/roots/layers.ts"),
      join(boxSrc, "internal/roots/command.runtime.ts"),
      join(boxSrc, "internal/roots/modeld.runtime.ts"),
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const name of EXECUTOR_NAMES) {
        expect(source.includes(name), `${file} mentions ${name}`).toBe(false);
      }
    }
  });

  test("retired controller source has no witness or tick body", async () => {
    const source = await readFile(join(boxSrc, "internal/roots/controller.runtime.ts"), "utf8");
    expect(source).not.toContain("LegacyWitness");
    expect(source).not.toContain("legacyWitness");
    expect(source).not.toContain("runWatchdogTickBody");
    expect(source).not.toContain("observeAndHeal");
    expect(source).toContain("legacy controller executor removed");
  });

  test("retired live-inject source cannot reach h3-live or process signals", async () => {
    const source = await readFile(join(boxSrc, "internal/process/live-inject.ts"), "utf8");
    expect(source).not.toContain("runH3LiveIdentitySession");
    expect(source).not.toContain("signalIfMatch");
    expect(source).not.toContain("armGuardian");
    expect(source).toContain("legacy-inject-removed");
  });

  test("watchdog/manual/cutover entry points throw and do not return a mutation receipt", async () => {
    const input = { root: "/tmp/legacy-removed", desired, models, now: () => 0 };
    await expect(runWatchdogTick(input)).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(runWatchdogCutover(input)).rejects.toMatchObject({ code: "invalid_usage" });
    await expect(runManualReadopt({ ...input, confirmed: false })).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("--confirm"),
    });
    await expect(runManualReadopt({ ...input, confirmed: true })).rejects.toMatchObject({
      code: "invalid_usage",
      message: expect.stringContaining("legacy controller executor removed"),
    });
  });

  test("live-inject entry points stay blocked with zero fake-tree signals", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor");
    const host = tree.spawn("host");
    const chain = await runIdentityChainInject({
      processes: tree,
      wrapper,
      supervisor,
      host,
      diskSha: () => "sha",
      roles: () => tree.roles(),
      spawnHost: () => tree.spawn("host"),
      readMarker: () => ({ transformed: true, mode: "identity", modeld: false }),
      wait: async () => false,
      now: () => 0,
    });
    expect(chain).toMatchObject({ ok: false, code: "legacy-inject-removed", coverage: "none" });
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);

    expect(await runLiveIdentityInject()).toMatchObject({ ok: false, code: "live-host-blocked", coverage: "none" });
    expect(await runLiveIdentityInject({
      root: "/tmp/legacy-inject",
      preloadPath: "/tmp/preload.cjs",
      reviewedProfilePath: "/tmp/reviewed.json",
    })).toMatchObject({ ok: false, code: "live-host-blocked", coverage: "none" });
    expect(await runLiveIdentityDeactivate({ root: "/tmp/legacy-inject" })).toMatchObject({
      ok: false,
      code: "live-host-blocked",
    });
  });
});
