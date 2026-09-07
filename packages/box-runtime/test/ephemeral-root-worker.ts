import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { expectedCompileReceipt } from "../src/compile-receipt.ts";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../src/attestation.ts";
import {
  runManualReadopt,
  runWatchdogTick,
  WATCHDOG_OPERATION_ID,
} from "../src/coordinator.ts";
import { ephemeralRuntimeRoot } from "../src/ephemeral.ts";
import { armGuardian } from "../src/guardian.ts";
import { liveH3AdoptAdapter, wireLiveManualReadopt } from "../src/live-readopt.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import { projectLiveStatus } from "../src/observe.ts";
import { coordinatorLeasePath, operationLockPath } from "../src/op-lock.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
import { adoptOpStatePath } from "../src/transient-adopt.ts";
import { SHA, reviewed, targetFor } from "./admission-fixture.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: null, agents: {} } };

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!process.env.HOME) fail("HOME must be set");
if (homedir() !== process.env.HOME) fail(`homedir ${homedir()} !== HOME ${process.env.HOME}`);

const runRoot = join(homedir(), ".grokbox", "run");
if (runRoot === "/home/box/.grokbox/run") fail("refusing to mutate the real home run root");
if (ephemeralRuntimeRoot() !== runRoot) fail(`default root ${ephemeralRuntimeRoot()} !== ${runRoot}`);

async function snapshot(dir: string): Promise<string> {
  let names: string[] = [];
  try {
    names = (await readdir(dir, { recursive: true })).map(String).sort();
  } catch {
    return "";
  }
  const parts = await Promise.all(
    names.map(async (name) => {
      try {
        return `${name}:${await readFile(join(dir, name), "utf8")}`;
      } catch {
        return `${name}:`;
      }
    }),
  );
  return parts.join("\n");
}

function desired(mode: DesiredFile["mode"]): DesiredFile {
  return { version: 1, mode };
}

function ident(partial: Partial<ProcessIdentity> & Pick<ProcessIdentity, "pid" | "cmdline">): ProcessIdentity {
  return {
    uid: 1000,
    start: 1,
    exe: "/exec-daemon/node",
    ppid: 1,
    ancestry: [1],
    ...partial,
  };
}

function officialChain() {
  const wrapper = ident({
    pid: 11,
    exe: "/usr/local/bin/supervise-sand-supervisor",
    cmdline: ["/usr/local/bin/supervise-sand-supervisor"],
    ppid: 1,
    ancestry: [1],
  });
  const supervisor = ident({
    pid: 22,
    cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
    ppid: wrapper.pid,
    ancestry: [wrapper.pid, 1],
  });
  const host = ident({
    pid: 33,
    start: 100,
    cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"],
    ppid: supervisor.pid,
    ancestry: [supervisor.pid, wrapper.pid, 1],
  });
  return { wrapper, supervisor, host };
}

function portOf(list: ProcessIdentity[]): ProcessPort {
  const signals: Array<{ pid: number; signal: SignalName }> = [];
  return {
    inspect: (pid) => list.find((row) => row.pid === pid) ?? null,
    list: () => [...list],
    signal: (expected, signal) => {
      signals.push({ pid: expected.pid, signal });
      return { ok: false, reason: "not-found" };
    },
  };
}

function attFor(host: ProcessIdentity, diskSha = SHA): CoverageAttestation {
  return {
    mode: "identity",
    coverage: "attested",
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-09-05T00:00:00.000Z",
    modeld: false,
    windowMs: 12,
    launchMode: "transient-adopt",
  };
}

function classify(tree: FakeProcessTree) {
  return (row: { pid: number }) => {
    const found = tree.roles().find((role) => role.pid === row.pid);
    if (found?.role === "wrapper" || found?.role === "supervisor" || found?.role === "host") return found.role;
    if (found?.role === "temp-supervisor") return "temp-supervisor";
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

function harness(tree: FakeProcessTree, wrapper: ProcessIdentity) {
  let patchedPid = 0;
  let gatewayPid: number | null = tree.roles().find((row) => row.role === "host")?.pid ?? null;
  const touched = new Set<number>();
  return {
    touch: (pid: number) => {
      touched.add(pid);
    },
    envHas: (pid: number, key: string) =>
      touched.has(pid) &&
      (key === "GROKBOX_PRELOAD_MODE" || key === "GROKBOX_OPERATION_ID" || key === "GROKBOX_PRELOAD_MARKER"),
    adopt: {
      target: targetFor(),
      spawnTempSupervisor: async () => {
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        patchedPid = born.pid;
        gatewayPid = born.pid;
        touched.add(born.pid);
        return temp;
      },
      waitNewHost: async (oldPid: number) =>
        tree.list().find((row) => classify(tree)(row) === "host" && row.pid !== oldPid) ?? null,
      waitGone: async (old: ProcessIdentity) => tree.inspect(old.pid) === null,
      waitReady: async (pid: number) => ({
        operationId: WATCHDOG_OPERATION_ID,
        pid,
        start: tree.inspect(pid)!.start,
        mode: "identity" as const,
        transformed: true as const,
        compiled: true as const,
        modeld: false as const,
        compile: expectedCompileReceipt(reviewed),
      }),
      armGuardian: async (frozen: ProcessIdentity[]) =>
        guard(tree, frozen, () => {
          if (!tree.roles().some((row) => row.role === "supervisor")) {
            tree.spawn("supervisor", { parent: wrapper });
          }
        }),
      hasGrokboxPreload: (row: ProcessIdentity) => row.pid === patchedPid,
      readGatewayPid: () => gatewayPid,
      adoptProveMs: 200,
    },
  };
}

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

async function statusCanonical(): Promise<unknown> {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (!xdg) fail("XDG_RUNTIME_DIR required");
  const durable = await mkdtemp(join(tmpdir(), "grokbox-status-durable-"));
  const { wrapper, supervisor, host } = officialChain();
  const xdgRoot = join(xdg, "grokbox");
  await writeAttestation(runRoot, attFor(host));
  await writeAttestation(xdgRoot, attFor(host, "xdg-decoy-sha"));
  const beforeHome = await snapshot(runRoot);
  const beforeXdg = await snapshot(xdgRoot);
  const status = await projectLiveStatus({
    root: durable,
    desired: desired("identity"),
    models: MODELS,
    processes: portOf([wrapper, supervisor, host]),
    diskSha: SHA,
    envHas: (pid, key) => pid === host.pid && key === "GROKBOX_PRELOAD_MODE",
  });
  return {
    defaultRoot: ephemeralRuntimeRoot(),
    runRoot,
    origin: status.host.origin,
    reason: status.host.reason,
    coverage: status.coverage,
    homeUnchanged: (await snapshot(runRoot)) === beforeHome,
    xdgUnchanged: (await snapshot(xdgRoot)) === beforeXdg,
  };
}

async function watchdogWiring(): Promise<unknown> {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (!xdg) fail("XDG_RUNTIME_DIR required");
  const durable = await mkdtemp(join(tmpdir(), "grokbox-wd-durable-"));
  const tree = new FakeProcessTree();
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  tree.spawn("host", { parent: supervisor });
  const ports = harness(tree, wrapper);
  const beforeXdg = await snapshot(xdg);
  const first = await runWatchdogTick({
    root: durable,
    desired: desired("identity"),
    models: MODELS,
    processes: tree,
    classify: classify(tree),
    diskSha: SHA,
    reviewedProfile: reviewed,
    adopt: ports.adopt,
    envHas: ports.envHas,
    now: () => 10,
    isoNow: () => "2026-01-01T00:00:00.000Z",
  });
  const homeAtt = await readAttestation(runRoot);
  const journal = await readFile(adoptOpStatePath(runRoot), "utf8");
  const override = await mkdtemp(join(tmpdir(), "grokbox-eph-override-"));
  const tree2 = new FakeProcessTree();
  const wrapper2 = tree2.spawn("wrapper");
  const supervisor2 = tree2.spawn("supervisor", { parent: wrapper2 });
  tree2.spawn("host", { parent: supervisor2 });
  const ports2 = harness(tree2, wrapper2);
  const beforeHome = await snapshot(runRoot);
  const second = await runWatchdogTick({
    root: await mkdtemp(join(tmpdir(), "grokbox-wd-durable-2-")),
    desired: desired("identity"),
    models: MODELS,
    processes: tree2,
    classify: classify(tree2),
    ephemeralRoot: override,
    diskSha: SHA,
    reviewedProfile: reviewed,
    adopt: ports2.adopt,
    envHas: ports2.envHas,
    now: () => 10,
    isoNow: () => "2026-01-01T00:00:00.000Z",
  });
  const original = liveH3AdoptAdapter.createLiveH3AdoptPorts;
  const calls: Array<{ markerPath: string; overlayPath: string }> = [];
  liveH3AdoptAdapter.createLiveH3AdoptPorts = ((input: { markerPath: string; overlayPath: string }) => {
    calls.push(input);
    return stubLiveAdoptPorts() as unknown as ReturnType<typeof original>;
  }) as typeof original;
  try {
    const wiredDefault = wireLiveManualReadopt({ root: durable, now: () => 0 });
    const wiredOverride = wireLiveManualReadopt({ root: durable, ephemeralRoot: override, now: () => 0 });
    return {
      first: { reconcile: first.reconcile, origin: first.origin },
      homeAtt,
      journalHasAttested: journal.includes("attested"),
      leasePath: coordinatorLeasePath(ephemeralRuntimeRoot()),
      lockPath: operationLockPath(ephemeralRuntimeRoot()),
      xdgUnchanged: (await snapshot(xdg)) === beforeXdg,
      second: { reconcile: second.reconcile },
      overrideAtt: await readAttestation(override),
      homeUnchangedAfterOverride: (await snapshot(runRoot)) === beforeHome,
      wiredDefaultRoot: wiredDefault.ephemeralRoot,
      wiredOverrideRoot: wiredOverride.ephemeralRoot,
      markerPaths: calls.map((call) => (call as { markerPath: string; overlayPath: string })),
    };
  } finally {
    liveH3AdoptAdapter.createLiveH3AdoptPorts = original;
  }
}

async function noImport(): Promise<unknown> {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (!xdg) fail("XDG_RUNTIME_DIR required");
  const durable = await mkdtemp(join(tmpdir(), "grokbox-decoy-durable-"));
  const tmpDecoy = await mkdtemp(join(tmpdir(), "grokbox-tmp-decoy-"));
  const { wrapper, supervisor, host } = officialChain();
  await writeAttestation(join(xdg, "grokbox"), attFor(host));
  await writeAttestation(tmpDecoy, attFor(host));
  const beforeHome = await snapshot(runRoot);
  const status = await projectLiveStatus({
    root: durable,
    desired: desired("identity"),
    models: MODELS,
    processes: portOf([wrapper, supervisor, host]),
    diskSha: SHA,
    envHas: (pid, key) => pid === host.pid && key === "GROKBOX_PRELOAD_MODE",
  });
  const afterStatus = await snapshot(runRoot);
  const tree = new FakeProcessTree();
  const w = tree.spawn("wrapper");
  const s = tree.spawn("supervisor", { parent: w });
  const h = tree.spawn("host", { parent: s });
  const ports = harness(tree, w);
  ports.touch(h.pid);
  const readopt = await runManualReadopt({
    confirmed: true,
    root: durable,
    desired: desired("identity"),
    models: MODELS,
    processes: tree,
    classify: classify(tree),
    diskSha: SHA,
    reviewedProfile: reviewed,
    adopt: ports.adopt,
    envHas: ports.envHas,
    now: () => 10,
    isoNow: () => "2026-01-01T00:00:00.000Z",
  });
  return {
    origin: status.host.origin,
    coverage: status.coverage,
    readopt: {
      origin: readopt.origin,
      reconcile: readopt.reconcile,
      signaled: readopt.signaled,
      injected: readopt.injected,
    },
    homeAtt: await readAttestation(runRoot),
    homeUnchangedAfterStatus: afterStatus === beforeHome,
    xdgStillThere: (await readFile(join(xdg, "grokbox", "attestation.json"), "utf8")).includes("attested"),
    tmpStillThere: (await readFile(join(tmpDecoy, "attestation.json"), "utf8")).includes("attested"),
  };
}

const scenario = process.argv[2];
const run =
  scenario === "status-canonical"
    ? statusCanonical
    : scenario === "watchdog-wiring"
      ? watchdogWiring
      : scenario === "no-import"
        ? noImport
        : null;
if (!run) fail(`unknown scenario ${scenario}`);
console.log(JSON.stringify(await run()));
