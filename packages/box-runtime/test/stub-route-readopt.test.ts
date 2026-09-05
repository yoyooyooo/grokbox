import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestation, writeAttestation } from "../src/attestation.ts";
import { runManualReadopt, runWatchdogTick, WATCHDOG_OPERATION_ID } from "../src/coordinator.ts";
import { armGuardian } from "../src/guardian.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
import type { PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } };
const SHA = "sha-reviewed";
const reviewed: PatchProfile = {
  profileId: "reviewed-route",
  sourceSha256: SHA,
  transformedSourceSha256: "sha-transformed-route",
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
    root: await mkdtemp(join(tmpdir(), "grokbox-stub-readopt-durable-")),
    ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-stub-readopt-eph-")),
  };
}

function spawnOfficial(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  return { wrapper, supervisor, host };
}

function spawnAdopted(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host");
  return { wrapper, supervisor, host };
}

function attFor(host: ProcessIdentity, diskSha = SHA, mode: "identity" | "route" = "identity") {
  return {
    mode,
    coverage: "attested" as const,
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-01-01T00:00:00.000Z",
    modeld: mode === "route",
    launchMode: "transient-adopt" as const,
    profileId: reviewed.profileId,
    transformedSha: reviewed.transformedSourceSha256,
  };
}

function countingPort(inner: ProcessPort) {
  const counts = { signal: 0 };
  const port: ProcessPort = {
    inspect: (pid) => inner.inspect(pid),
    list: () => inner.list(),
    signal: (expected, signal: SignalName) => {
      counts.signal += 1;
      return inner.signal(expected, signal);
    },
  };
  return { port, counts };
}

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity, gateway: { pid: number | null }, markerMode: { current: "identity" | "route" }) {
  let patchedPid = 0;
  let spawns = 0;
  const touched = new Set<number>();
  return {
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
        mode: markerMode.current,
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

describe("stub route fake-process re-adopt", () => {
  test("identity-to-route refresh runs once then is a no-op; mismatches do not signal", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const gateway = { pid: null as number | null };
    const markerMode = { current: "identity" as "identity" | "route" };
    const ports = harness(tree, wrapper, gateway, markerMode);
    const identityTick = {
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
      modeldReady: async () => false,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const identity = await runManualReadopt(identityTick);
    expect(identity.reconcile).toBe("converged");
    expect(identity.injected).toBe(true);
    expect(identity.signaled).toBe(true);
    const liveAfterIdentity = tree.roles().find((row) => row.role === "host");
    expect(liveAfterIdentity).toBeDefined();

    markerMode.current = "route";
    const routeTick = {
      ...identityTick,
      desired: desired("route"),
      modeldReady: async () => true,
      waitReplacement: async () => {
        const sup = tree.roles().find((row) => row.role === "supervisor") ?? wrapper;
        const born = tree.spawn("host", { parent: sup });
        gateway.pid = born.pid;
        return born;
      },
      envHas: (pid: number, key: string) =>
        ports.envHas(pid, key) ||
        (liveAfterIdentity != null &&
          pid === liveAfterIdentity.pid &&
          (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER")),
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) =>
          ident.pid === liveAfterIdentity?.pid || ports.adopt.hasGrokboxPreload(ident),
      },
    };
    const first = await runManualReadopt(routeTick);
    expect(first.reason, JSON.stringify(first)).toBeNull();
    expect(first.reconcile).toBe("converged");
    expect(first.injected).toBe(true);
    expect(first.signaled).toBe(true);
    const att = await readAttestation(ephemeralRoot);
    expect(att).toMatchObject({
      mode: "route",
      modeld: true,
      diskSha: SHA,
      profileId: reviewed.profileId,
      transformedSha: reviewed.transformedSourceSha256,
    });
    const afterFirst = tree.signals.length;

    const second = await runManualReadopt(routeTick);
    expect(second.reconcile).toBe("converged");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(tree.signals.length).toBe(afterFirst);

    const mismatchRoots = await roots();
    const mismatchTree = new FakeProcessTree();
    const mismatch = spawnAdopted(mismatchTree);
    const mismatchGateway = { pid: mismatch.host.pid as number | null };
    const mismatchPorts = harness(mismatchTree, mismatch.wrapper, mismatchGateway, markerMode);
    await writeAttestation(mismatchRoots.ephemeralRoot, attFor(mismatch.host, "other-sha"));
    const counted = countingPort(mismatchTree);
    const bad = await runManualReadopt({
      confirmed: true,
      root: mismatchRoots.root,
      desired: desired("route"),
      models: MODELS,
      processes: counted.port,
      classify: classify(mismatchTree),
      ephemeralRoot: mismatchRoots.ephemeralRoot,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: mismatchPorts.adopt,
      envHas: (pid, key) =>
        pid === mismatch.host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      modeldReady: async () => true,
      now: () => 10,
    });
    expect(bad.reconcile).toBe("recovery-required");
    expect(bad.signaled).toBe(false);
    expect(counted.counts.signal).toBe(0);
    expect(mismatchTree.signals).toEqual([]);

    const unreadiness = await runWatchdogTick({
      ...routeTick,
      confirmed: false,
      modeldReady: async () => false,
    });
    expect(["blocked", "recovery-required"]).toContain(unreadiness.reconcile);
    expect(unreadiness.signaled).toBe(false);
  });

  test("official route adopt requires confirm and modeld readiness", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
    const gateway = { pid: null as number | null };
    const markerMode = { current: "route" as "identity" | "route" };
    const ports = harness(tree, wrapper, gateway, markerMode);
    const base = {
      root,
      desired: desired("route"),
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
    const unconfirmed = await runWatchdogTick({ ...base, modeldReady: async () => true });
    expect(unconfirmed.reconcile).toBe("blocked");
    expect(unconfirmed.reason).toBe("route_requires_confirm");
    expect(unconfirmed.signaled).toBe(false);
    expect(tree.alive(host.pid)).toBe(true);

    const notReady = await runManualReadopt({
      ...base,
      confirmed: true,
      modeldReady: async () => false,
    });
    expect(notReady.reconcile).toBe("blocked");
    expect(notReady.reason).toBe("modeld_not_ready");
    expect(notReady.signaled).toBe(false);
    expect(tree.signals).toEqual([]);

    const adopted = await runManualReadopt({
      ...base,
      confirmed: true,
      modeldReady: async () => true,
    });
    expect(adopted.reconcile).toBe("converged");
    expect(adopted.injected).toBe(true);
    expect(adopted.signaled).toBe(true);
    expect(await readAttestation(ephemeralRoot)).toMatchObject({ mode: "route", modeld: true, diskSha: SHA });
  });
});
