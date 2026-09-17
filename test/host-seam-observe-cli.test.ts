import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import * as credentials from "../packages/box-runtime/src/internal/io/credentials.node.ts";
import { coordinatorStatePath, runtimeConfigPath as desiredPath, hostBundlesDir } from "../packages/box-runtime/src/internal/io/paths.ts";
import { liveStatusAdapter } from "../packages/box-runtime/src/internal/io/observe.ts";
import { liveH3AdoptAdapter } from "../packages/box-runtime/src/internal/process/live-readopt.ts";
import { snapshotTree } from "../packages/box-runtime/test/observation-fixture.ts";
import { SYNTHETIC_HOST } from "../packages/box-runtime/test/synthetic-host.ts";
import { captureCli, parseJson } from "./helpers.ts";

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("HSO-1 observe CLI", () => {
  test("CLI observe A then B retains both generations and HEAD", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-cli-ab-"));
    const hostA = join(boxRuntimeRoot, "host-a.cjs");
    const hostB = join(boxRuntimeRoot, "host-b.cjs");
    const bodyB = `${SYNTHETIC_HOST}\n// generation-B\n`;
    await writeFile(hostA, SYNTHETIC_HOST);
    await writeFile(hostB, bodyB);
    const deps = { discoveryPath: "/dev/null", boxRuntimeRoot };
    const first = await captureCli(["runtime", "profile", "observe", "--from", hostA], deps);
    expect(first.code, first.stderr).toBe(0);
    const second = await captureCli(["runtime", "profile", "observe", "--from", hostB], deps);
    expect(second.code, second.stderr).toBe(0);
    const shaA = sha256Text(SYNTHETIC_HOST);
    const shaB = sha256Text(bodyB);
    expect(data(first.stdout).observedSha).toBe(shaA);
    expect(data(second.stdout).observedSha).toBe(shaB);
    expect(data(first.stdout).signaled).toBe(false);
    expect(data(second.stdout).adopted).toBe(false);
    const bundles = hostBundlesDir(boxRuntimeRoot);
    expect((await readFile(join(bundles, "HEAD"), "utf8")).trim()).toBe(shaB);
    expect(await readFile(join(bundles, "generations", shaA, "source"), "utf8")).toBe(SYNTHETIC_HOST);
    expect(await readFile(join(bundles, "generations", shaB, "source"), "utf8")).toBe(bodyB);
    const metaA = JSON.parse(await readFile(join(bundles, "generations", shaA, "meta.json"), "utf8"));
    const metaB = JSON.parse(await readFile(join(bundles, "generations", shaB, "meta.json"), "utf8"));
    expect(metaA.sourceSha).toBe(shaA);
    expect(metaB.sourceSha).toBe(shaB);
  });

  test("circuit open, missing desired, and completed control-op still sample without healing control state", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-cli-circuit-"));
    const host = join(boxRuntimeRoot, "host.cjs");
    await writeFile(host, SYNTHETIC_HOST);
    await mkdir(dirname(coordinatorStatePath(boxRuntimeRoot)), { recursive: true });
    const coordinator = {
      version: 1,
      circuit: "open",
      circuitReason: "mutation_budget",
      mutationCount: 4,
      attemptedKeys: ["reconcile:done"],
      lastAttemptKey: "reconcile:done",
    };
    await writeFile(coordinatorStatePath(boxRuntimeRoot), `${JSON.stringify(coordinator)}\n`);
    const beforeCoordinator = await readFile(coordinatorStatePath(boxRuntimeRoot), "utf8");
    const observed = await captureCli(["runtime", "profile", "observe", "--from", host], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(observed.code, observed.stderr).toBe(0);
    expect(data(observed.stdout).retained).toBe("new");
    expect(await readFile(coordinatorStatePath(boxRuntimeRoot), "utf8")).toBe(beforeCoordinator);
    expect(await readFile(desiredPath(boxRuntimeRoot), "utf8").catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  });

  test("default observe has zero adopt/credential/network effects; status does not mutate the tree", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-cli-prim-"));
    const host = join(boxRuntimeRoot, "host.cjs");
    await writeFile(host, SYNTHETIC_HOST);
    const liveSpy = spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts");
    const secretSpy = spyOn(credentials, "materializeApiKeyRef");
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetches += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const observed = await captureCli(["runtime", "profile", "observe", "--from", host], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
        fetch: (async () => {
          throw new Error("observe must not use network");
        }) as unknown as typeof fetch,
      });
      expect(observed.code, observed.stderr).toBe(0);
      expect(liveSpy).not.toHaveBeenCalled();
      expect(secretSpy).not.toHaveBeenCalled();
      expect(fetches).toBe(0);
      const runRoot = join(boxRuntimeRoot, "missing-run");
      const statusSpies = [
        spyOn(liveStatusAdapter, "runRoot").mockReturnValue(runRoot),
        spyOn(liveStatusAdapter, "processes").mockImplementation(() => ({ inspect: () => null, list: () => [], signal: () => ({ ok: false as const, reason: "not-found" as const }) })),
        spyOn(liveStatusAdapter, "envHas").mockReturnValue(false),
        spyOn(liveStatusAdapter, "diskSha").mockResolvedValue({ state: "unavailable" }),
        spyOn(liveStatusAdapter, "gatewayPid").mockResolvedValue({ state: "missing" }),
        spyOn(liveStatusAdapter, "modeldReady").mockResolvedValue(false),
      ];
      try {
        const before = await snapshotTree(boxRuntimeRoot);
        const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
        expect(status.code, status.stderr).toBe(0);
        expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
      } finally {
        for (const spy of statusSpies) spy.mockRestore();
      }
    } finally {
      globalThis.fetch = originalFetch;
      liveSpy.mockRestore();
      secretSpy.mockRestore();
    }
  });
});
