import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveH3AdoptAdapter, runManualReadopt, wireLiveManualReadopt } from "../src/index.ts";
import {
  resolveRuntimeHelpers,
  RUNTIME_HELPER_FILES,
  RUNTIME_HELPER_GUARDIAN_CHILD,
  RUNTIME_HELPER_INJECTOR_HOLD,
  RUNTIME_HELPER_PRELOAD,
  RUNTIME_HELPER_TEMP_SUPERVISOR,
} from "../src/runtime-helpers.ts";

const SRC = dirname(fileURLToPath(new URL("../src/runtime-helpers.ts", import.meta.url)));

function stubLiveAdoptPorts() {
  const processes = {
    inspect: () => null,
    list: () => [],
    signal: () => ({ ok: false as const, reason: "not-found" as const }),
  };
  return {
    processes,
    classify: () => null,
    waitHostGone: async () => true,
    supervisorRelaunch: async () => null,
    waitReady: async () => null,
    applyLaunchEnv: async () => undefined,
    hasGrokboxPreload: () => false,
    spawnTempSupervisor: async () => null,
    waitNewHost: async () => null,
    readGatewayPid: () => null,
    guardianDeadlineMs: 1,
    waitBudgetMs: 1,
    adoptProveMs: 1,
  };
}

describe("runtime helper published layout", () => {
  test("source layout helpers exist beside the resolver", () => {
    const helpers = resolveRuntimeHelpers();
    expect(existsSync(helpers.guardianChild)).toBe(true);
    expect(existsSync(helpers.injectorHold)).toBe(true);
    expect(existsSync(helpers.tempSupervisor)).toBe(true);
    expect(existsSync(helpers.preload)).toBe(true);
    expect(helpers.guardianChild).toBe(join(SRC, RUNTIME_HELPER_GUARDIAN_CHILD));
    expect(helpers.injectorHold).toBe(join(SRC, RUNTIME_HELPER_INJECTOR_HOLD));
    expect(helpers.tempSupervisor).toBe(join(SRC, RUNTIME_HELPER_TEMP_SUPERVISOR));
  });

  test("published dist layout resolves Node-runnable preload.cjs, not preload.ts", async () => {
    const dist = await mkdtemp(join(tmpdir(), "grokbox-published-helpers-"));
    const indexJs = join(dist, "index.js");
    await writeFile(indexJs, "export {};\n");
    await writeFile(join(dist, RUNTIME_HELPER_PRELOAD), "module.exports = {};\n");
    await copyFile(join(SRC, RUNTIME_HELPER_GUARDIAN_CHILD), join(dist, RUNTIME_HELPER_GUARDIAN_CHILD));
    await copyFile(join(SRC, RUNTIME_HELPER_INJECTOR_HOLD), join(dist, RUNTIME_HELPER_INJECTOR_HOLD));
    await copyFile(join(SRC, RUNTIME_HELPER_TEMP_SUPERVISOR), join(dist, RUNTIME_HELPER_TEMP_SUPERVISOR));
    const helpers = resolveRuntimeHelpers(pathToFileURL(indexJs).href);
    expect(helpers.preload).toBe(join(dist, RUNTIME_HELPER_PRELOAD));
    expect(helpers.preload.endsWith("preload.ts")).toBe(false);
    expect(existsSync(join(dist, "preload.ts"))).toBe(false);
    for (const name of RUNTIME_HELPER_FILES) {
      expect(existsSync(join(dist, name))).toBe(true);
    }
  });

  test("confirmed composition traverses the live adapter without touching the real Host", async () => {
    const spy = spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts").mockImplementation(() => stubLiveAdoptPorts());
    try {
      const root = await mkdtemp(join(tmpdir(), "grokbox-helper-readopt-"));
      const ephemeralRoot = await mkdtemp(join(tmpdir(), "grokbox-helper-readopt-eph-"));
      await writeFile(
        join(root, "models.json"),
        `${JSON.stringify({ version: 1, models: {}, assignments: { main: null, agents: {} } })}\n`,
      );
      const wired = wireLiveManualReadopt({ root, ephemeralRoot, now: () => 0 });
      expect(spy).toHaveBeenCalledTimes(1);
      const needle = (spy.mock.calls[0]?.[0] as { preloadNeedle?: string } | undefined)?.preloadNeedle;
      expect(typeof needle).toBe("string");
      expect(existsSync(needle!)).toBe(true);
      const result = await runManualReadopt({
        confirmed: true,
        root,
        desired: { version: 1, mode: "identity" },
        models: { version: 1, models: {}, assignments: { main: null, agents: {} } },
        now: () => 0,
        ...wired,
        freshDiskSha: () => "none",
      });
      expect(result.injected).toBe(false);
      expect(result.signaled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
