import { describe, expect, test } from "bun:test";
import { expectedCompileReceipt } from "../src/compile-receipt.ts";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestation, writeAttestation } from "../src/attestation.ts";
import {
  runManualReadopt,
  runWatchdogTick,
  WATCHDOG_MUTATION_BUDGET,
  WATCHDOG_OPERATION_ID,
} from "../src/coordinator.ts";
import { BoxRuntimeError } from "../src/errors.ts";
import { armGuardian } from "../src/guardian.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import { findAdoptedHostState, findUniqueOfficialChain } from "../src/official-chain.ts";
import { coordinatorStatePath } from "../src/paths.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
import { writeAdoptOpState } from "../src/transient-adopt.ts";
import { SHA, NEW_SHA, reviewed, reviewedFor, targetFor } from "./admission-fixture.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: null, agents: {} } };

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

function spawnAdopted(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host");
  return { wrapper, supervisor, host };
}

function attFor(host: ProcessIdentity, diskSha = SHA) {
  return {
    mode: "identity" as const,
    coverage: "attested" as const,
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-01-01T00:00:00.000Z",
    modeld: false as const,
    launchMode: "transient-adopt" as const,
  };
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

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity, gateway: { pid: number | null }, sha = SHA) {
  if (gateway.pid == null) gateway.pid = tree.roles().find((row) => row.role === "host")?.pid ?? null;
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
      target: targetFor(sha),
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
        mode: "identity" as const,
        transformed: true as const,
        compiled: true as const,
        modeld: false as const,
        compile: expectedCompileReceipt(reviewedFor(sha)),
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
    const live = await readFile(new URL("../src/live-readopt.ts", import.meta.url), "utf8");
    expect(live).toContain("createLiveH3AdoptPorts");
    expect(live).toContain("pinLaunchProfile");
    expect(live).not.toContain("/tmp");
    expect(live).not.toMatch(/glob\(/);
    expect(live).not.toMatch(/SIGKILL/);
  });
});

describe("manual re-adopt stale attestation and live-port no-op", () => {
  test("matching SHA is a strict no-op even with live-capable ports", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnAdopted(tree);
    const gateway = { pid: host.pid as number | null };
    const ports = harness(tree, wrapper, gateway);
    const touched = host.pid;
    const envHas = (pid: number, key: string) =>
      pid === touched &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER");
    await writeAttestation(ephemeralRoot, attFor(host));
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
      adopt: { ...ports.adopt, hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === host.pid },
      envHas,
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    for (let i = 0; i < 5; i += 1) {
      const result = await runManualReadopt(tick);
      expect(result.reconcile).toBe("converged");
      expect(result.injected).toBe(false);
      expect(result.signaled).toBe(false);
      expect(result.origin).toBe("grokbox-attested");
    }
    expect(ports.spawns()).toBe(0);
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("watchdog does not mutate a stale-attested Host", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnAdopted(tree);
    const gateway = { pid: host.pid as number | null };
    const ports = harness(tree, wrapper, gateway, NEW_SHA);
    await writeAttestation(ephemeralRoot, attFor(host, "old-sha"));
    const result = await runWatchdogTick({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      reviewedProfile: reviewedFor(NEW_SHA),
      adopt: ports.adopt,
      envHas: (pid, key) =>
        pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      now: () => 10,
    });
    expect(result.reconcile).toBe("converged");
    expect(result.injected).toBe(false);
    expect(result.signaled).toBe(false);
    expect(result.origin).toBe("grokbox-attested");
    expect(result.reason).toBe("stale_attestation");
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("stale-attested adopted Host deactivates once then transient-adopts", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, supervisor, host } = spawnAdopted(tree);
    const gateway = { pid: host.pid as number | null };
    const ports = harness(tree, wrapper, gateway, NEW_SHA);
    await writeAttestation(ephemeralRoot, attFor(host, "old-sha"));
    const envHas = (pid: number, key: string) =>
      ports.envHas(pid, key) ||
      (pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"));
    const tick = {
      confirmed: true as const,
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      reviewedProfile: reviewedFor(NEW_SHA),
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) =>
          ident.pid === host.pid || ports.adopt.hasGrokboxPreload(ident),
      },
      envHas,
      waitReplacement: async () => {
        const sup = tree.roles().find((row) => row.role === "supervisor") ?? supervisor;
        const born = tree.spawn("host", { parent: sup });
        gateway.pid = born.pid;
        return born;
      },
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const first = await runManualReadopt(tick);
    expect(first.reason, JSON.stringify(first)).toBeNull();
    expect(first.reconcile).toBe("converged");
    expect(first.injected).toBe(true);
    expect(first.origin).toBe("grokbox-attested");
    expect(tree.alive(host.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    expect(ports.spawns()).toBe(1);
    const liveHost = tree.roles().find((row) => row.role === "host");
    const liveSupervisor = tree.roles().find((row) => row.role === "supervisor");
    expect(liveHost).toBeDefined();
    expect(liveHost!.pid).not.toBe(host.pid);
    expect(liveSupervisor).toBeDefined();
    expect(liveHost!.ppid).not.toBe(liveSupervisor!.pid);
    expect(findUniqueOfficialChain(tree, classify(tree)).ok).toBe(false);
    const adopted = findAdoptedHostState(tree, classify(tree), {
      gatewayPid: gateway.pid,
      expectedHost: liveHost,
    });
    expect(adopted.ok).toBe(true);
    const att = await readAttestation(ephemeralRoot);
    expect(att?.diskSha).toBe(NEW_SHA);
    expect(att?.pid).toBe(liveHost!.pid);
    expect(att?.launchMode).toBe("transient-adopt");
    const afterFirst = tree.signals.filter((row) => row.signal === "SIGTERM").length;

    const second = await runManualReadopt(tick);
    expect(second.reconcile).toBe("converged");
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(ports.spawns()).toBe(1);
    expect(tree.signals.filter((row) => row.signal === "SIGTERM").length).toBe(afterFirst);
  });

  test("fail-closed: missing/mismatched profile, unowned, ambiguous, gateway, pending journal", async () => {
    async function once(mutate: (input: {
      tree: FakeProcessTree;
      host: ProcessIdentity;
      wrapper: ProcessIdentity;
      gateway: { pid: number | null };
      ports: ReturnType<typeof harness>;
      root: string;
      ephemeralRoot: string;
    }) => Promise<Parameters<typeof runManualReadopt>[0]> | Parameters<typeof runManualReadopt>[0]) {
      const { root, ephemeralRoot } = await roots();
      const tree = new FakeProcessTree();
      const { wrapper, host } = spawnAdopted(tree);
      const gateway = { pid: host.pid as number | null };
      const ports = harness(tree, wrapper, gateway, NEW_SHA);
      await writeAttestation(ephemeralRoot, attFor(host, "old-sha"));
      const tick = await mutate({ tree, host, wrapper, gateway, ports, root, ephemeralRoot });
      const beforeSignals = tree.signals.length;
      const result = await runManualReadopt(tick);
      expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
      return { result, tree, ports, host, beforeSignals };
    }

    const missing = await once(({ tree, host, wrapper, gateway, ports, root, ephemeralRoot }) => ({
      confirmed: true as const,
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === host.pid,
      },
      envHas: (pid: number, key: string) =>
        pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      now: () => 10,
    }));
    expect(missing.result.injected).toBe(false);
    expect(missing.result.signaled).toBe(false);
    expect(missing.result.reason).toBe("missing_reviewed_profile");
    expect(missing.tree.alive(missing.host.pid)).toBe(true);
    expect(missing.tree.signals.length).toBe(missing.beforeSignals);

    const mismatched = await once(({ tree, host, ports, root, ephemeralRoot }) => ({
      confirmed: true as const,
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      reviewedProfile: reviewedFor("other-sha"),
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === host.pid,
      },
      envHas: (pid: number, key: string) =>
        pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      now: () => 10,
    }));
    expect(mismatched.result.injected).toBe(false);
    expect(mismatched.result.signaled).toBe(false);
    expect(mismatched.result.reason).toBe("unknown-sha");
    expect(mismatched.tree.signals.length).toBe(mismatched.beforeSignals);

    const { root: unownedRoot, ephemeralRoot: unownedEph } = await roots();
    const unownedTree = new FakeProcessTree();
    const unowned = spawnOfficial(unownedTree);
    const unownedPorts = harness(unownedTree, unowned.wrapper, { pid: unowned.host.pid });
    const unownedResult = await runManualReadopt({
      confirmed: true,
      root: unownedRoot,
      desired: desired("identity"),
      models: MODELS,
      processes: unownedTree,
      classify: classify(unownedTree),
      ephemeralRoot: unownedEph,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: unownedPorts.adopt,
      envHas: (pid, key) =>
        pid === unowned.host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      now: () => 10,
    });
    expect(unownedResult.reconcile).toBe("recovery-required");
    expect(unownedResult.reason).toBe("unmanaged_preload");
    expect(unownedResult.signaled).toBe(false);
    expect(unownedTree.signals).toEqual([]);

    const { root: ambRoot, ephemeralRoot: ambEph } = await roots();
    const ambTree = new FakeProcessTree();
    const amb = spawnOfficial(ambTree);
    ambTree.spawn("host", { parent: amb.supervisor });
    const ambResult = await runManualReadopt({
      confirmed: true,
      root: ambRoot,
      desired: desired("identity"),
      models: MODELS,
      processes: ambTree,
      classify: classify(ambTree),
      ephemeralRoot: ambEph,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: harness(ambTree, amb.wrapper, { pid: amb.host.pid }).adopt,
      now: () => 10,
    });
    expect(ambResult.reconcile).toBe("recovery-required");
    expect(ambResult.reason).toBe("duplicate_role");
    expect(ambResult.signaled).toBe(false);
    expect(ambTree.signals).toEqual([]);

    const gateway = await once(({ tree, host, ports, root, ephemeralRoot }) => ({
      confirmed: true as const,
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      reviewedProfile: reviewedFor(NEW_SHA),
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === host.pid,
        readGatewayPid: () => host.pid + 99,
      },
      envHas: (pid: number, key: string) =>
        pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      now: () => 10,
    }));
    expect(gateway.result.reconcile).toBe("recovery-required");
    expect(gateway.result.reason).toBe("gateway-mismatch");
    expect(gateway.result.signaled).toBe(false);
    expect(gateway.tree.signals.length).toBe(gateway.beforeSignals);

    const { root: pendRoot, ephemeralRoot: pendEph } = await roots();
    const pendTree = new FakeProcessTree();
    const pend = spawnOfficial(pendTree);
    const temp = pendTree.spawn("temp-supervisor");
    await writeAdoptOpState(pendEph, {
      launchMode: "transient-adopt",
      tempSupervisor: temp,
      adoptingSupervisor: null,
      host: null,
    });
    const pendResult = await runManualReadopt({
      confirmed: true,
      root: pendRoot,
      desired: desired("identity"),
      models: MODELS,
      processes: pendTree,
      classify: classify(pendTree),
      ephemeralRoot: pendEph,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: harness(pendTree, pend.wrapper, { pid: pend.host.pid }).adopt,
      now: () => 10,
    });
    expect(pendResult.reconcile).toBe("recovery-required");
    expect(pendResult.reason).toBe("pending-uncertain");
    expect(pendResult.signaled).toBe(false);
    expect(pendTree.signals).toEqual([]);
    expect(pendTree.alive(pend.host.pid)).toBe(true);
  });

  test("confirmed fresh key bypasses exhausted mutation budget once; same key and journal do not", async () => {
    const { root, ephemeralRoot } = await roots();
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(
      coordinatorStatePath(root),
      `${JSON.stringify({
        version: 1,
        circuit: "open",
        circuitReason: "mutation_budget",
        mutationCount: WATCHDOG_MUTATION_BUDGET,
        attemptedKeys: [],
      })}\n`,
      { mode: 0o600 },
    );
    const tree = new FakeProcessTree();
    const { wrapper, host } = spawnOfficial(tree);
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
    expect(first.injected).toBe(true);
    expect(first.reconcile).toBe("converged");
    expect(ports.spawns()).toBe(1);
    expect(tree.alive(host.pid)).toBe(false);
    const afterFirst = tree.signals.length;

    const second = await runManualReadopt(tick);
    expect(second.injected).toBe(false);
    expect(second.signaled).toBe(false);
    expect(ports.spawns()).toBe(1);
    expect(tree.signals.length).toBe(afterFirst);

    const { root: journalRoot, ephemeralRoot: journalEph } = await roots();
    await mkdir(join(journalRoot, "state"), { recursive: true, mode: 0o700 });
    await writeFile(
      coordinatorStatePath(journalRoot),
      `${JSON.stringify({
        version: 1,
        circuit: "open",
        circuitReason: "mutation_budget",
        mutationCount: WATCHDOG_MUTATION_BUDGET,
        attemptedKeys: [],
      })}\n`,
      { mode: 0o600 },
    );
    const journalTree = new FakeProcessTree();
    const journal = spawnOfficial(journalTree);
    const temp = journalTree.spawn("temp-supervisor");
    await writeAdoptOpState(journalEph, {
      launchMode: "transient-adopt",
      phase: "spawn-temp",
      tempSupervisor: temp,
      adoptingSupervisor: null,
      host: null,
    });
    const journalResult = await runManualReadopt({
      confirmed: true,
      root: journalRoot,
      desired: desired("identity"),
      models: MODELS,
      processes: journalTree,
      classify: classify(journalTree),
      ephemeralRoot: journalEph,
      diskSha: SHA,
      reviewedProfile: reviewed,
      adopt: harness(journalTree, journal.wrapper, { pid: null }).adopt,
      now: () => 10,
    });
    expect(journalResult.reconcile).toBe("recovery-required");
    expect(journalResult.reason).toBe("pending-uncertain");
    expect(journalResult.injected).toBe(false);
    expect(journalResult.signaled).toBe(false);
    expect(journalTree.signals).toEqual([]);
  });

  test("deactivate success then unproven adopt stops on official chain without retry", async () => {
    const { root, ephemeralRoot } = await roots();
    const tree = new FakeProcessTree();
    const { wrapper, supervisor, host } = spawnAdopted(tree);
    const gateway = { pid: host.pid as number | null };
    const ports = harness(tree, wrapper, gateway, NEW_SHA);
    await writeAttestation(ephemeralRoot, attFor(host, "old-sha"));
    let spawns = 0;
    const tick = {
      confirmed: true as const,
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: tree,
      classify: classify(tree),
      ephemeralRoot,
      diskSha: NEW_SHA,
      reviewedProfile: reviewedFor(NEW_SHA),
      adopt: {
        ...ports.adopt,
        hasGrokboxPreload: (ident: ProcessIdentity) => ident.pid === host.pid,
        spawnTempSupervisor: async () => {
          spawns += 1;
          return null;
        },
      },
      envHas: (pid: number, key: string) =>
        pid === host.pid &&
        (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
      waitReplacement: async () => {
        const born = tree.spawn("host", { parent: supervisor });
        gateway.pid = born.pid;
        return born;
      },
      now: () => 10,
      isoNow: () => "2026-01-01T00:00:00.000Z",
    };
    const first = await runManualReadopt(tick);
    expect(first.reconcile).toBe("recovery-required");
    expect(first.injected).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    expect(spawns).toBe(1);
    const afterFirst = tree.signals.length;
    const second = await runManualReadopt(tick);
    expect(second.reconcile).toBe("recovery-required");
    expect(second.reason).toBe("pending-uncertain");
    expect(second.signaled).toBe(false);
    expect(spawns).toBe(1);
    expect(tree.signals.length).toBe(afterFirst);
  });
});
