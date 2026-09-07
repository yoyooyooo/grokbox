import { describe, expect, test } from "bun:test";
import { expectedCompileReceipt } from "../src/compile-receipt.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attestationPath,
  readAttestation,
  writeAttestation,
  type CoverageAttestation,
} from "../src/attestation.ts";
import { runManualReadopt, runWatchdogTick, WATCHDOG_OPERATION_ID } from "../src/coordinator.ts";
import { armGuardian } from "../src/guardian.ts";
import { startStubModeldServer } from "../src/modeld-ipc.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import { projectLiveStatus } from "../src/observe.ts";
import { reviewedProfilePath } from "../src/paths.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
import type { PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";
import { SHA, reviewed, nextProfile, targetFor } from "./admission-fixture.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } };

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

async function writeReviewed(root: string, profile: PatchProfile = reviewed): Promise<void> {
  await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
  await writeFile(reviewedProfilePath(root), `${JSON.stringify(profile)}\n`);
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

function attFor(host: ProcessIdentity, diskSha = SHA, mode: "identity" | "route" = "identity"): CoverageAttestation {
  if (mode === "route") {
    return {
      mode: "route",
      coverage: "attested",
      diskSha,
      pid: host.pid,
      start: host.start,
      identity: host,
      at: "2026-01-01T00:00:00.000Z",
      modeld: true,
      launchMode: "transient-adopt",
      profileId: reviewed.profileId,
      transformedSha: reviewed.transformedSourceSha256,
    };
  }
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
  if (gateway.pid == null) gateway.pid = tree.roles().find((row) => row.role === "host")?.pid ?? null;
  let patchedPid = 0;
  let spawns = 0;
  let launchProfile = reviewed;
  const touched = new Set<number>();
  return {
    spawns: () => spawns,
    envHas: (pid: number, key: string) =>
      touched.has(pid) &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
    adopt: {
      target: targetFor(),
      prepareTempLaunch: async (profile: PatchProfile) => { launchProfile = structuredClone(profile); },
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
        start: tree.inspect(pid)!.start,
        mode: markerMode.current,
        transformed: true as const,
        compiled: true as const,
        modeld: false as const,
        compile: expectedCompileReceipt(launchProfile),
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

  test("confirmed re-adopt refreshes already-route Host when reviewed profile SHA changes", async () => {
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
      modeldReady: async () => true,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const adopted = await runManualReadopt({ ...base, confirmed: true });
    expect(adopted.reconcile).toBe("converged");
    expect(adopted.injected).toBe(true);
    expect(tree.alive(host.pid)).toBe(false);
    const live = tree.roles().find((row) => row.role === "host");
    expect(live).toBeDefined();
    const afterAdoptSignals = tree.signals.length;

    const nextReviewed = nextProfile;
    const unconfirmed = await runWatchdogTick({ ...base, reviewedProfile: nextReviewed });
    expect(unconfirmed.reconcile).toBe("recovery-required");
    expect(unconfirmed.reason).toBe("route_mismatch");
    expect(unconfirmed.signaled).toBe(false);
    expect(unconfirmed.injected).toBe(false);
    expect(tree.signals.length).toBe(afterAdoptSignals);

    const refreshed = await runManualReadopt({
      ...base,
      confirmed: true,
      reviewedProfile: nextReviewed,
      waitReplacement: async () => {
        const sup = tree.roles().find((row) => row.role === "supervisor") ?? wrapper;
        const born = tree.spawn("host", { parent: sup });
        gateway.pid = born.pid;
        return born;
      },
    });
    expect(refreshed.reason, JSON.stringify(refreshed)).toBeNull();
    expect(refreshed.reconcile).toBe("converged");
    expect(refreshed.injected).toBe(true);
    expect(refreshed.signaled).toBe(true);
    expect(tree.signals.length).toBeGreaterThan(afterAdoptSignals);
    expect(await readAttestation(ephemeralRoot)).toMatchObject({
      mode: "route",
      modeld: true,
      diskSha: SHA,
      profileId: nextReviewed.profileId,
      transformedSha: nextReviewed.transformedSourceSha256,
    });
  });

  test("read-only watchdog/status use reviewed profile identity without mutation ports", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { host } = spawnAdopted(tree);
    await writeReviewed(root);
    await writeAttestation(ephemeralRoot, attFor(host, SHA, "route"));
    const envHas = (pid: number, key: string) =>
      pid === host.pid &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER");
    const modeld = await startStubModeldServer({ runRoot: ephemeralRoot, durableRoot: root });
    try {
      const healthy = await runWatchdogTick({
        gatewayPid: host.pid,
        root,
        desired: desired("route"),
        models: MODELS,
        processes: tree,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        envHas,
        modeldReady: async () => true,
        now: () => 10,
      });
      expect(healthy.reconcile).toBe("converged");
      expect(healthy.reason).toBeNull();
      expect(healthy.injected).toBe(false);
      expect(healthy.signaled).toBe(false);
      expect(tree.signals).toEqual([]);

      const status = await projectLiveStatus({
        gatewayPid: host.pid,
        modeldReady: () => true,
        root,
        desired: desired("route"),
        models: MODELS,
        processes: tree,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        envHas,
      });
      expect(status.coverage).toBe("attested");
      expect(status.host.origin).toBe("grokbox-attested");

      await writeReviewed(root, { ...reviewed, profileId: "reviewed-replaced", transformedSourceSha256: "sha-new" });
      const mismatched = await runWatchdogTick({
        gatewayPid: host.pid,
        root,
        desired: desired("route"),
        models: MODELS,
        processes: tree,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        envHas,
        modeldReady: async () => true,
        now: () => 10,
      });
      expect(mismatched.reconcile).toBe("recovery-required");
      expect(mismatched.reason).toBe("route_mismatch");
      expect(mismatched.signaled).toBe(false);
      expect(tree.signals).toEqual([]);
      const staleStatus = await projectLiveStatus({
        gatewayPid: host.pid,
        modeldReady: () => true,
        root,
        desired: desired("route"),
        models: MODELS,
        processes: tree,
        classify: classify(tree),
        ephemeralRoot,
        diskSha: SHA,
        envHas,
      });
      expect(staleStatus.coverage).toBe("window-open");
      expect(staleStatus.host.origin).toBe("grokbox-attested");
    } finally {
      await modeld.stop();
    }
  });

  test("route attestation without profile identity is not attested; non-stub assignment is refused", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { host } = spawnAdopted(tree);
    await writeReviewed(root);
    const envHas = (pid: number, key: string) =>
      pid === host.pid &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER");
    const incomplete = attFor(host, SHA, "route");
    await writeFile(
      attestationPath(ephemeralRoot),
      `${JSON.stringify({ ...incomplete, profileId: undefined, transformedSha: undefined })}\n`,
    );
    const missing = await runWatchdogTick({
      root,
      desired: desired("route"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      envHas,
      reviewedProfile: reviewed,
      modeldReady: async () => true,
      now: () => 10,
    });
    expect(missing.reconcile).toBe("recovery-required");
    expect(missing.signaled).toBe(false);

    await writeAttestation(ephemeralRoot, attFor(host, SHA, "route"));
    const drifted = await runWatchdogTick({
      root,
      desired: desired("route"),
      models: { ...MODELS, assignments: { main: "acme/fast", agents: {} } },
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: SHA,
      envHas,
      reviewedProfile: reviewed,
      modeldReady: async () => true,
      now: () => 10,
    });
    expect(drifted.reconcile).toBe("recovery-required");
    expect(drifted.reason).toBe("non_stub_assignment");
    expect(drifted.signaled).toBe(false);
    expect(tree.signals).toEqual([]);
  });
});
