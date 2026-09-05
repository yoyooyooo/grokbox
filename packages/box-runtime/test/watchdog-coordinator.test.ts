import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttestation, type CoverageAttestation } from "../src/attestation.ts";
import {
  runWatchdogTick,
  WATCHDOG_MUTATION_BUDGET,
  WATCHDOG_OPERATION_ID,
} from "../src/coordinator.ts";
import { armGuardian } from "../src/guardian.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import type { ProcessIdentity } from "../src/process.ts";
import { writeAdoptOpState } from "../src/transient-adopt.ts";
import type { PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: null, agents: {} } };
const SHA = "sha-reviewed";
const DECOY_DIR = "/tmp/box-runtime-keep-identity-ephemeral";
const reviewed: PatchProfile = {
  profileId: "reviewed",
  sourceSha256: SHA,
  transformedSourceSha256: "sha-transformed",
  slices: [
    { id: "create-session", startAnchor: "a", endAnchor: "b", find: "c", replacement: "d" },
    { id: "agent-id", startAnchor: "e", endAnchor: "f", find: "g", replacement: "h" },
  ],
};

function desired(mode: DesiredFile["mode"]): DesiredFile {
  return { version: 1, mode };
}

function classify(tree: FakeProcessTree) {
  return (ident: { pid: number }) => {
    const row = tree.roles().find((role) => role.pid === ident.pid);
    if (row?.role === "wrapper" || row?.role === "supervisor" || row?.role === "host") return row.role;
    if (row?.role === "temp-supervisor") return "temp-supervisor";
    return null;
  };
}

function guard(tree: FakeProcessTree, frozen: Array<{ pid: number }>, onRelease?: () => void) {
  const g = armGuardian({
    wrapper: frozen[0] as never,
    processes: tree,
    deadlineMs: 5000,
    now: () => 0,
    wait: hangUntilAbort(),
  });
  return {
    ok: true as const,
    release: () => {
      g.close();
      onRelease?.();
    },
  };
}

function terms(tree: FakeProcessTree): number {
  return tree.signals.filter((row) => row.signal === "SIGTERM").length;
}

function attFor(host: ProcessIdentity, diskSha = SHA): CoverageAttestation {
  return {
    mode: "identity",
    coverage: "attested",
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-01-01T00:00:00.000Z",
    modeld: false,
    launchMode: "transient-adopt",
  };
}

async function roots() {
  return {
    root: await mkdtemp(join(tmpdir(), "grokbox-wd-durable-")),
    ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-wd-eph-")),
  };
}

function spawnOfficial(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  return { wrapper, supervisor, host };
}

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity) {
  let patchedPid = 0;
  let gatewayPid: number | null = null;
  const touched = new Set<number>();
  return {
    patchedPid: () => patchedPid,
    touch: (pid: number) => {
      touched.add(pid);
    },
    clearTouched: () => {
      touched.clear();
    },
    envHas: (pid: number, key: string) =>
      touched.has(pid) &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
    adopt: {
      spawnTempSupervisor: async () => {
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        patchedPid = born.pid;
        gatewayPid = born.pid;
        touched.add(born.pid);
        return temp;
      },
      waitNewHost: async (oldPid: number) =>
        tree.list().find((ident) => classify(tree)(ident) === "host" && ident.pid !== oldPid) ?? null,
      waitGone: async (old: ProcessIdentity) => tree.inspect(old.pid) === null,
      waitReady: async (pid: number) => ({
        operationId: WATCHDOG_OPERATION_ID,
        pid,
        mode: "identity" as const,
        transformed: true as const,
        compiled: true as const,
        modeld: false as const,
      }),
      armGuardian: async (frozen: ProcessIdentity[]) =>
        guard(tree, frozen, () => {
          if (!tree.roles().some((row) => row.role === "supervisor")) {
            tree.spawn("supervisor", { parent: wrapper });
          }
        }),
      hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === patchedPid,
      readGatewayPid: () => gatewayPid,
      adoptProveMs: 200,
    },
  };
}

describe("offline watchdog desired-state coordinator", () => {
  test("identity on official singleton adopts once; matching att is a no-op", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const ports = harness(tree, wrapper);
    const tick = {
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: ports.adopt,
      envHas: ports.envHas,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const first = await runWatchdogTick(tick);
    expect(first.reconcile).toBe("converged");
    expect(first.injected).toBe(true);
    expect(first.origin).toBe("grokbox-attested");
    expect(first.signaled).toBe(true);
    expect(tree.alive(host.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    const afterFirst = terms(tree);

    const second = await runWatchdogTick(tick);
    expect(second.reconcile).toBe("converged");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(second.origin).toBe("grokbox-attested");
    expect(terms(tree)).toBe(afterFirst);
  });

  test("grokbox-unattested is recovery-required with zero signals and ignores /tmp att", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    await mkdir(DECOY_DIR, { recursive: true });
    const decoyFile = join(DECOY_DIR, "attestation.json");
    let previous: string | null = null;
    try {
      previous = await readFile(decoyFile, "utf8");
    } catch {
      previous = null;
    }
    await writeFile(decoyFile, `${JSON.stringify(attFor(host))}\n`);
    try {
      const result = await runWatchdogTick({
        root,
        desired: desired("identity"),
        models: MODELS,
        processes: tree,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        reviewedProfile: reviewed,
        adopt: harness(tree, wrapper).adopt,
        envHas: (pid, key) => pid === host.pid && key === "GROKBOX_PRELOAD_MODE",
        now: () => 10,
      });
      expect(result.reconcile).toBe("recovery-required");
      expect(result.reason).toBe("unmanaged_preload");
      expect(result.injected).toBe(false);
      expect(result.signaled).toBe(false);
      expect(tree.signals).toEqual([]);
      expect(tree.alive(host.pid)).toBe(true);
    } finally {
      if (previous == null) {
        const { unlink } = await import("node:fs/promises");
        await unlink(decoyFile).catch(() => undefined);
      } else {
        await writeFile(decoyFile, previous);
      }
    }
  });

  test("interrupted adopt-op is reconciled before retry and does not mutate", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const temp = tree.spawn("temp-supervisor");
    await writeAdoptOpState(ephemeralRoot, {
      launchMode: "transient-adopt",
      tempSupervisor: temp,
      adoptingSupervisor: null,
      host: null,
    });
    const before = terms(tree);
    const result = await runWatchdogTick({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: harness(tree, wrapper).adopt,
      now: () => 10,
    });
    expect(result.reconcile).toBe("recovery-required");
    expect(result.reason).toBe("pending-uncertain");
    expect(result.injected).toBe(false);
    expect(result.signaled).toBe(false);
    expect(result.circuit).toBe("open");
    expect(terms(tree)).toBe(before);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("official relaunch re-attests a new generation once and then storms open the circuit", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper } = spawnOfficial(tree);
    const ports = harness(tree, wrapper);
    const tick = () => ({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: ports.adopt,
      envHas: ports.envHas,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    });

    const first = await runWatchdogTick(tick());
    expect(first.injected).toBe(true);
    expect(first.reconcile).toBe("converged");

    async function relaunchOfficial() {
      const liveHost = tree.roles().find((row) => row.role === "host");
      if (liveHost) tree.signal(liveHost, "SIGTERM");
      const supervisor = tree.roles().find((row) => row.role === "supervisor");
      expect(supervisor).toBeDefined();
      ports.clearTouched();
      tree.spawn("host", { parent: supervisor });
      const { unlink } = await import("node:fs/promises");
      await unlink(join(ephemeralRoot, "attestation.json")).catch(() => undefined);
    }

    await relaunchOfficial();
    const second = await runWatchdogTick(tick());
    expect(second.injected).toBe(true);
    expect(second.reconcile).toBe("converged");
    expect(WATCHDOG_MUTATION_BUDGET).toBe(2);

    await relaunchOfficial();
    const storm = await runWatchdogTick(tick());
    expect(storm.injected).toBe(false);
    expect(storm.signaled).toBe(false);
    expect(storm.reconcile).toBe("blocked");
    expect(storm.reason).toBe("mutation_budget");
    expect(storm.circuit).toBe("open");
  });

  test("signaled adopt failure opens the circuit and does not blind-retry the same generation", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const ports = harness(tree, wrapper);
    const tick = {
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: {
        ...ports.adopt,
        prepareTempLaunch: async () => {
          throw new Error("injector-dead");
        },
      },
      envHas: ports.envHas,
      now: () => 10,
    };
    const first = await runWatchdogTick(tick);
    expect(first.reconcile).toBe("recovery-required");
    expect(first.reason).toBe("injector-dead");
    expect(first.circuit).toBe("open");
    expect(first.injected).toBe(false);
    expect(tree.alive(host.pid)).toBe(true);
    const afterFirst = tree.signals.length;

    const second = await runWatchdogTick(tick);
    expect(second.reconcile).toBe("recovery-required");
    expect(second.reason).toBe("pending-uncertain");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(tree.signals.length).toBe(afterFirst);
  });

  test("disabled and observe do not mutate an official singleton; route stays blocked", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const ports = harness(tree, wrapper);
    const base = {
      root,
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: ports.adopt,
      now: () => 10,
    };
    const disabled = await runWatchdogTick({ ...base, desired: desired("disabled") });
    expect(disabled.reconcile).toBe("converged");
    expect(disabled.injected).toBe(false);
    expect(tree.alive(host.pid)).toBe(true);
    expect(tree.signals).toEqual([]);

    const observe = await runWatchdogTick({ ...base, desired: desired("observe") });
    expect(observe.reconcile).toBe("converged");
    expect(observe.injected).toBe(false);
    expect(tree.signals).toEqual([]);

    const route = await runWatchdogTick({ ...base, desired: desired("route") });
    expect(route.reconcile).toBe("blocked");
    expect(route.reason).toBe("route_requires_confirm");
    expect(route.injected).toBe(false);
    expect(tree.signals).toEqual([]);
  });

  test("matching canonical attestation is a no-op even when adopt ports exist", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const ports = harness(tree, wrapper);
    ports.touch(host.pid);
    await writeAttestation(ephemeralRoot, attFor(host));
    const result = await runWatchdogTick({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: ports.adopt,
      envHas: ports.envHas,
      now: () => 10,
    });
    expect(result.reconcile).toBe("converged");
    expect(result.injected).toBe(false);
    expect(result.signaled).toBe(false);
    expect(result.origin).toBe("grokbox-attested");
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("CLI-shaped tick without adopt ports never signals", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    spawnOfficial(tree);
    const result = await runWatchdogTick({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      now: () => 10,
    });
    expect(result.injected).toBe(false);
    expect(result.signaled).toBe(false);
    expect(result.reconcile).toBe("blocked");
    expect(result.reason).toBe("missing_reviewed_profile");
    expect(tree.signals).toEqual([]);
  });

  test("coordinator source has no SIGKILL, /tmp import, or process.kill", async () => {
    const src = await readFile(new URL("../src/coordinator.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/SIGKILL/);
    expect(src).not.toContain("process.kill");
    expect(src).not.toContain("/tmp");
    expect(src).not.toContain("h3-live");
  });
});
