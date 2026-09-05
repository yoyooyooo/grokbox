import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManualReadopt, WATCHDOG_OPERATION_ID } from "../src/coordinator.ts";
import { BoxRuntimeError } from "../src/errors.ts";
import { armGuardian } from "../src/guardian.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
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
    root: await mkdtemp(join(tmpdir(), "grokbox-readopt-durable-")),
    ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-readopt-eph-")),
  };
}

function spawnOfficial(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  return { wrapper, supervisor, host };
}

function countingPort(inner: ProcessPort) {
  const counts = { list: 0, inspect: 0, signal: 0 };
  const port: ProcessPort = {
    inspect: (pid) => {
      counts.inspect += 1;
      return inner.inspect(pid);
    },
    list: () => {
      counts.list += 1;
      return inner.list();
    },
    signal: (expected, signal: SignalName) => {
      counts.signal += 1;
      return inner.signal(expected, signal);
    },
  };
  return { port, counts };
}

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity, gateway: { pid: number | null }) {
  let patchedPid = 0;
  let spawns = 0;
  const touched = new Set<number>();
  return {
    patchedPid: () => patchedPid,
    spawns: () => spawns,
    envHas: (pid: number, key: string) =>
      touched.has(pid) &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
    adopt: {
      spawnTempSupervisor: async () => {
        spawns += 1;
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
      hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === patchedPid,
      readGatewayPid: () => gateway.pid,
      adoptProveMs: 200,
    },
  };
}

describe("manual re-adopt one-shot", () => {
  test("missing confirmation refuses before process preflight or signals", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    spawnOfficial(tree);
    const counted = countingPort(tree);
    let error: unknown;
    try {
      await runManualReadopt({
        confirmed: false,
        root,
        desired: desired("identity"),
        models: MODELS,
        processes: counted.port,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        reviewedProfile: reviewed,
        now: () => 10,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoxRuntimeError);
    expect((error as BoxRuntimeError).code).toBe("invalid_usage");
    expect(counted.counts.list).toBe(0);
    expect(counted.counts.inspect).toBe(0);
    expect(counted.counts.signal).toBe(0);
    expect(tree.signals).toEqual([]);
  });

  test("gateway-pid mismatch is recovery-required and does not retry", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const gateway = { pid: host.pid as number | null };
    const ports = harness(tree, wrapper, gateway);
    const tick = {
      confirmed: true as const,
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
        readGatewayPid: () => host.pid,
      },
      envHas: ports.envHas,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const first = await runManualReadopt(tick);
    expect(first.reconcile).toBe("recovery-required");
    expect(first.reason).toBe("gateway-unproven");
    expect(first.injected).toBe(false);
    expect(ports.spawns()).toBe(1);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    const afterFirst = tree.signals.length;

    const second = await runManualReadopt(tick);
    expect(second.reconcile).toBe("recovery-required");
    expect(second.reason).toBe("pending-uncertain");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(ports.spawns()).toBe(1);
    expect(tree.signals.length).toBe(afterFirst);
  });

  test("confirmed identity on official singleton logically adopts once", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, supervisor, host } = spawnOfficial(tree);
    const gateway = { pid: null as number | null };
    const ports = harness(tree, wrapper, gateway);
    const tick = {
      confirmed: true as const,
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
    const first = await runManualReadopt(tick);
    expect(first.reconcile).toBe("converged");
    expect(first.injected).toBe(true);
    expect(first.origin).toBe("grokbox-attested");
    expect(first.signaled).toBe(true);
    expect(tree.alive(host.pid)).toBe(false);
    expect(tree.alive(supervisor.pid)).toBe(false);
    const liveHost = tree.roles().find((row) => row.role === "host");
    const liveSupervisor = tree.roles().find((row) => row.role === "supervisor");
    expect(liveHost).toBeDefined();
    expect(liveSupervisor).toBeDefined();
    expect(liveHost!.ppid).not.toBe(liveSupervisor!.pid);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    expect(ports.spawns()).toBe(1);
    const afterFirst = tree.signals.filter((row) => row.signal === "SIGTERM").length;

    const second = await runManualReadopt(tick);
    expect(second.reconcile).toBe("converged");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(second.origin).toBe("grokbox-attested");
    expect(ports.spawns()).toBe(1);
    expect(tree.signals.filter((row) => row.signal === "SIGTERM").length).toBe(afterFirst);
  });

  test("source reuses coordinator and has no second writer or SIGKILL", async () => {
    const src = await readFile(new URL("../src/coordinator.ts", import.meta.url), "utf8");
    expect(src).toContain("export async function runManualReadopt");
    expect(src).toMatch(/return await runWatchdogTick\(input\);/);
    expect(src).not.toMatch(/for\s*\(.*runWatchdogTick/);
    expect(src).not.toMatch(/while\s*\(.*runWatchdogTick/);
    expect(src).not.toMatch(/SIGKILL/);
    expect(src).not.toContain("process.kill");
    expect(src).not.toContain("h3-live");
  });
});
