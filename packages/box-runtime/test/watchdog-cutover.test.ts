import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWatchdogCutover,
  runWatchdogTick,
  WATCHDOG_OPERATION_ID,
} from "../src/coordinator.ts";
import { armGuardian } from "../src/guardian.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import { coordinatorLeasePath } from "../src/op-lock.ts";
import type { ProcessIdentity } from "../src/process.ts";
import type { PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: null, agents: {} } };
const SHA = "sha-reviewed";
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

async function roots() {
  return {
    root: await mkdtemp(join(tmpdir(), "grokbox-cut-durable-")),
    ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-cut-eph-")),
  };
}

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity, gateway: { pid: number | null }) {
  let patchedPid = 0;
  const touched = new Set<number>();
  return {
    patchedPid: () => patchedPid,
    touch: (pid: number) => {
      touched.add(pid);
    },
    envHas: (pid: number, key: string) =>
      touched.has(pid) &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
    adopt: {
      spawnTempSupervisor: async () => {
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        patchedPid = born.pid;
        gateway.pid = born.pid;
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
      hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === patchedPid || touched.has(ident.pid),
      readGatewayPid: () => gateway.pid,
      adoptProveMs: 200,
    },
  };
}

describe("watchdog cutover composition", () => {
  test("legacy-adopted unattested Host deactivates to a different direct official then canonical-adopts", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const legacy = tree.spawn("host");
    const gateway = { pid: legacy.pid as number | null };
    const ports = harness(tree, wrapper, gateway);
    ports.touch(legacy.pid);

    const result = await runWatchdogCutover({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      freshDiskSha: () => SHA,
      reviewedProfile: reviewed,
      adopt: ports.adopt,
      envHas: ports.envHas,
      legacyWitness: { identity: legacy },
      waitReplacement: async () => {
        const sup = tree.roles().find((row) => row.role === "supervisor");
        const born = tree.spawn("host", { parent: sup });
        gateway.pid = born.pid;
        return born;
      },
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.reason, JSON.stringify(result)).toBeNull();
    expect(result.injected).toBe(true);
    expect(result.reconcile).toBe("converged");
    expect(result.origin).toBe("grokbox-attested");
    expect(tree.alive(legacy.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    const liveHost = tree.roles().find((row) => row.role === "host");
    expect(liveHost).toBeDefined();
    expect(liveHost?.pid).not.toBe(legacy.pid);
    expect(tree.roles().filter((row) => row.role === "host")).toHaveLength(1);
    expect(tree.roles().some((row) => row.role === "temp-supervisor")).toBe(false);
  });

  test("held coordinator lease blocks a concurrent mutator without signals", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    tree.spawn("host", { parent: supervisor });
    const gateway = { pid: null as number | null };
    const ports = harness(tree, wrapper, gateway);
    await mkdir(join(ephemeralRoot, "ops"), { recursive: true, mode: 0o700 });
    await writeFile(
      coordinatorLeasePath(ephemeralRoot),
      `${JSON.stringify({ pid: process.pid, start: 1, uid: 1000 })}\n`,
      { mode: 0o600 },
    );
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
      inspectLeaseOwner: (pid) => (pid === process.pid ? { pid, start: 1, uid: 1000 } : null),
      selfLease: { pid: process.pid, start: 1, uid: 1000 },
      now: () => 10,
    });
    expect(result.reconcile).toBe("blocked");
    expect(result.reason).toBe("lock-conflict");
    expect(result.injected).toBe(false);
    expect(tree.signals).toEqual([]);
  });

  test("stale coordinator lease is reclaimed; mutating phase journal is recovery-required", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const gateway = { pid: null as number | null };
    const ports = harness(tree, wrapper, gateway);
    await mkdir(join(ephemeralRoot, "ops"), { recursive: true, mode: 0o700 });
    await writeFile(
      coordinatorLeasePath(ephemeralRoot),
      `${JSON.stringify({ pid: 999999, start: 1, uid: 1 })}\n`,
      { mode: 0o600 },
    );

    const reclaimed = await runWatchdogTick({
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
      inspectLeaseOwner: () => null,
      selfLease: { pid: process.pid, start: 2, uid: 1000 },
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    });
    expect(reclaimed.injected).toBe(true);
    expect(reclaimed.reconcile).toBe("converged");

    const { root: root2, ephemeralRoot: eph2 } = await roots();
    const tree2 = new FakeProcessTree();
    const w2 = tree2.spawn("wrapper");
    const s2 = tree2.spawn("supervisor", { parent: w2 });
    tree2.spawn("host", { parent: s2 });
    await mkdir(join(eph2, "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(eph2, "state", "adopt-op.json"), `${JSON.stringify({
      launchMode: "transient-adopt",
      phase: "wrapper-stop",
      tempSupervisor: null,
      adoptingSupervisor: null,
      host: host,
    })}\n`);
    const hung = await runWatchdogTick({
      root: root2,
      desired: desired("identity"),
      models: MODELS,
      processes: tree2,
      classify: classify(tree2),
      ephemeralRoot: eph2,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: harness(tree2, w2, { pid: null }).adopt,
      now: () => 10,
    });
    expect(hung.reconcile).toBe("recovery-required");
    expect(hung.reason).toBe("pending-uncertain");
    expect(hung.injected).toBe(false);
    expect(tree2.signals).toEqual([]);
  });

  test("cutover source never scans /tmp or SIGKILLs", async () => {
    const src = await readFile(new URL("../src/coordinator.ts", import.meta.url), "utf8");
    const adopt = await readFile(new URL("../src/transient-adopt.ts", import.meta.url), "utf8");
    expect(src).not.toContain("/tmp");
    expect(src).not.toMatch(/SIGKILL/);
    expect(adopt).not.toMatch(/SIGKILL/);
    expect(src).not.toContain("h3-live");
  });
});
