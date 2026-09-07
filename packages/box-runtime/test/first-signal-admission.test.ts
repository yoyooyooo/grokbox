import { describe, expect, spyOn, test } from "bun:test";
import { expectedCompileReceipt } from "../src/compile-receipt.ts";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../src/attestation.ts";
import { runManualReadopt, runWatchdogCutover, runWatchdogTick, WATCHDOG_MUTATION_BUDGET, WATCHDOG_OPERATION_ID, type WatchdogTickInput } from "../src/coordinator.ts";
import { armGuardian } from "../src/guardian.ts";
import { createLiveH3AdoptPorts, decideLivePreflight } from "../src/h3-live.ts";
import type { H3LaunchStrategy } from "../src/launch-strategy.ts";
import * as liveProc from "../src/live-proc.ts";
import { liveH3AdoptAdapter, wireLiveManualReadopt } from "../src/live-readopt.ts";
import { coordinatorStatePath, reviewedProfilePath } from "../src/paths.ts";
import { writeAdoptOpState } from "../src/transient-adopt.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";
import { SOURCE, NEW_SOURCE, SHA, NEW_SHA, reviewed, reviewedFor, nextProfile } from "./admission-fixture.ts";

type Scenario = "official identity" | "official route" | "stale identity" | "identity to route" | "route profile refresh";
const scenarios: Scenario[] = ["official identity", "official route", "stale identity", "identity to route", "route profile refresh"];

async function fixture(kind: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-first-signal-"));
  const ephemeralRoot = join(root, "run");
  const tree = new FakeProcessTree();
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const official = kind.startsWith("official");
  const host = tree.spawn("host", official ? { parent: supervisor } : undefined);
  const route = kind !== "official identity" && kind !== "stale identity";
  const source = { text: kind === "stale identity" ? NEW_SOURCE : SOURCE };
  const capability = { strategy: "transient-adopt-candidate" as H3LaunchStrategy };
  const profile = kind === "stale identity" ? reviewedFor(NEW_SHA) : kind === "route profile refresh" ? nextProfile : reviewed;
  const touched = new Set<number>(official ? [] : [host.pid]);
  const gateway = { pid: host.pid };
  const counts = { prepare: 0, guardian: 0, spawn: 0 };
  const classify = (ident: { pid: number }) => {
    const role = tree.roles().find((row) => row.pid === ident.pid)?.role;
    return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null;
  };
  const att: CoverageAttestation = kind === "route profile refresh" ? {
    mode: "route", coverage: "attested", diskSha: SHA, pid: host.pid, start: host.start, identity: host,
    at: "2026-01-01T00:00:00.000Z", modeld: true, launchMode: "transient-adopt",
    profileId: reviewed.profileId, transformedSha: reviewed.transformedSourceSha256,
  } : {
    mode: "identity", coverage: "attested", diskSha: SHA, pid: host.pid, start: host.start, identity: host,
    at: "2026-01-01T00:00:00.000Z", modeld: false, launchMode: "transient-adopt",
    profileId: reviewed.profileId, transformedSha: reviewed.transformedSourceSha256,
  };
  if (!official) await writeAttestation(ephemeralRoot, att);
  await mkdir(join(root, "profiles"), { recursive: true });
  await writeFile(reviewedProfilePath(root), JSON.stringify(profile));
  const input: WatchdogTickInput & { confirmed: true } = {
    confirmed: true, root, ephemeralRoot, processes: tree, classify,
    desired: { version: 1, mode: route ? "route" : "identity" },
    models: { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } },
    diskSha: kind === "stale identity" ? NEW_SHA : SHA,
    reviewedProfile: profile,
    now: () => 10,
    modeldReady: async () => true,
    envHas: (pid) => touched.has(pid),
    waitReplacement: async () => {
      const sup = tree.roles().find((row) => row.role === "supervisor")!;
      const born = tree.spawn("host", { parent: sup });
      gateway.pid = born.pid;
      return born;
    },
    adopt: {
      target: { readSource: () => source.text, launchStrategy: () => capability.strategy },
      prepareTempLaunch: async () => { counts.prepare += 1; },
      spawnTempSupervisor: async () => {
        counts.spawn += 1;
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        gateway.pid = born.pid;
        touched.add(born.pid);
        return temp;
      },
      waitNewHost: async (oldPid) => tree.roles().find((row) => row.role === "host" && row.pid !== oldPid) ?? null,
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReady: async (pid) => ({
        operationId: WATCHDOG_OPERATION_ID, pid, start: tree.inspect(pid)!.start, mode: route ? "route" : "identity",
        transformed: true, compiled: true, modeld: false,
        compile: expectedCompileReceipt(profile),
      }),
      armGuardian: async (frozen) => {
        counts.guardian += 1;
        const guardian = armGuardian({ wrapper: frozen[0]!, processes: tree, deadlineMs: 5000, now: () => 0, wait: hangUntilAbort() });
        return { ok: true, release: () => {
          guardian.close();
          if (!tree.roles().some((row) => row.role === "supervisor")) tree.spawn("supervisor", { parent: wrapper });
        } };
      },
      readGatewayPid: () => gateway.pid,
      hasGrokboxPreload: (ident) => touched.has(ident.pid),
      adoptProveMs: 100,
    },
  };
  const key = `${input.desired.mode}:${host.pid}:${host.start}:${input.diskSha}`;
  return { kind, root, ephemeralRoot, tree, wrapper, supervisor, host, official, source, capability, touched, gateway, counts, input, key, att };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const faults: Array<[string, (f: Fixture) => void | Promise<void>]> = [
  ["source bytes disagree", (f) => { f.source.text += "\n// unexpected disk bytes"; }],
  ["profile source SHA disagrees", (f) => { f.input.reviewedProfile = { ...f.input.reviewedProfile!, sourceSha256: "f".repeat(64) }; }],
  ["bad transformed SHA", (f) => { f.input.reviewedProfile = { ...f.input.reviewedProfile!, transformedSourceSha256: "0".repeat(64) }; }],
  ["empty slices", (f) => { f.input.reviewedProfile = { ...f.input.reviewedProfile!, slices: [] }; }],
  ["wrong slice ids", (f) => { const one = f.input.reviewedProfile!.slices[0]!; f.input.reviewedProfile = { ...f.input.reviewedProfile!, slices: [one, one] }; }],
  ["missing anchor", (f) => { f.input.reviewedProfile = { ...f.input.reviewedProfile!, slices: f.input.reviewedProfile!.slices.map((slice) => ({ ...slice, startAnchor: "absent anchor" })) }; }],
  ["capability unavailable", (f) => { f.capability.strategy = "unavailable"; }],
  ["wrong launch strategy", (f) => { f.capability.strategy = "direct-overlay"; }],
  ["missing target facts", (f) => { f.input.adopt!.target = undefined; }],
  ["gateway mismatch", (f) => { f.gateway.pid += 99; }],
  ["ownership mismatch", async (f) => {
    if (f.official) f.touched.add(f.host.pid);
    else await writeAttestation(f.ephemeralRoot, { ...f.att, identity: { ...f.host, start: f.host.start + 1 } });
  }],
  ["bad supervisor parentage", (f) => { f.tree.procs.get(f.supervisor.pid)!.ident.ppid = 999; }],
  ["supervisor preloaded", (f) => { f.touched.add(f.supervisor.pid); }],
  ["unsettled journal", async (f) => { await writeAdoptOpState(f.ephemeralRoot, {
    launchMode: "transient-adopt", phase: "wrapper-stop", tempSupervisor: null, adoptingSupervisor: null, host: f.host,
  }); }],
];

async function seedBudget(f: Fixture, count: number, keys: string[]) {
  await mkdir(join(f.root, "state"), { recursive: true });
  await writeFile(coordinatorStatePath(f.root), JSON.stringify({ version: 1, circuit: "closed", mutationCount: count, attemptedKeys: keys }));
}

describe("first-signal target admission on the shared coordinator", () => {
  test.each(scenarios.map((kind) => [kind] as const))("%s: invalid premises cause no signal, guardian or launch preparation", async (kind) => {
    for (const [name, mutate] of faults) {
      const f = await fixture(kind);
      await mutate(f);
      const before = await readAttestation(f.ephemeralRoot);
      const result = await runManualReadopt(f.input);
      const label = `${kind}: ${name}: ${JSON.stringify(result)}`;
      expect(result.reconcile, label).not.toBe("converged");
      expect(result.signaled, label).toBe(false);
      expect(result.injected, label).toBe(false);
      expect(f.tree.signals, label).toEqual([]);
      expect(f.tree.alive(f.host.pid), label).toBe(true);
      expect(f.counts, label).toEqual({ prepare: 0, guardian: 0, spawn: 0 });
      expect(await readAttestation(f.ephemeralRoot), label).toEqual(before);
    }
  });

  test.each(scenarios.map((kind) => [kind] as const))("%s: valid target converges once, then is a strict no-op", async (kind) => {
    const f = await fixture(kind);
    const first = await runManualReadopt(f.input);
    expect(first.reconcile, JSON.stringify(first)).toBe("converged");
    expect(first.injected).toBe(true);
    expect(first.signaled).toBe(true);
    expect(first.attemptKey).toBe(f.key);
    expect(f.counts).toEqual({ prepare: 1, guardian: 1, spawn: 1 });
    const signals = [...f.tree.signals];
    const state = JSON.parse(await readFile(coordinatorStatePath(f.root), "utf8"));
    expect(state.attemptedKeys).toContain(f.key);
    for (let i = 0; i < 3; i += 1) {
      const next = await runManualReadopt(f.input);
      expect(next.reconcile).toBe("converged");
      expect(next.signaled).toBe(false);
      expect(next.injected).toBe(false);
      expect(f.tree.signals).toEqual(signals);
      expect(f.counts).toEqual({ prepare: 1, guardian: 1, spawn: 1 });
    }
  });

  test.each(scenarios.map((kind) => [kind] as const))("%s: same-key dedupe runs before preparation or any signal", async (kind) => {
    const f = await fixture(kind);
    await seedBudget(f, 1, [f.key]);
    const result = await runManualReadopt(f.input);
    expect(result.reason).toBe("generation_attempted");
    expect(result.signaled).toBe(false);
    expect(f.tree.signals).toEqual([]);
    expect(f.counts).toEqual({ prepare: 0, guardian: 0, spawn: 0 });
  });

  test("automatic budget cannot mutate; one confirmed fresh refresh may bypass the historical limit", async () => {
    const automatic = await fixture("official identity");
    await seedBudget(automatic, WATCHDOG_MUTATION_BUDGET, []);
    const denied = await runWatchdogTick({ ...automatic.input, confirmed: false });
    expect(denied.reason).toBe("mutation_budget");
    expect(automatic.tree.signals).toEqual([]);
    for (const kind of ["stale identity", "identity to route", "route profile refresh"] as const) {
      const f = await fixture(kind);
      await seedBudget(f, WATCHDOG_MUTATION_BUDGET, []);
      const result = await runManualReadopt(f.input);
      expect(result.reconcile, JSON.stringify(result)).toBe("converged");
      expect(f.counts.spawn).toBe(1);
      const signals = [...f.tree.signals];
      expect((await runManualReadopt(f.input)).signaled).toBe(false);
      expect(f.tree.signals).toEqual(signals);
    }
  });

  test.each(scenarios.map((kind) => [kind] as const))("%s: preparation failure or late drift is refused before the operation's first signal", async (kind) => {
    for (const fault of ["prepare", "source", "journal"] as const) {
      const f = await fixture(kind);
      f.input.adopt!.prepareTempLaunch = async () => {
        f.counts.prepare += 1;
        if (fault === "prepare") throw new Error("synthetic preparation failure");
        if (fault === "source") f.source.text += "\n// changed during preparation";
        if (fault === "journal") await writeAdoptOpState(f.ephemeralRoot, {
          launchMode: "transient-adopt", phase: "wrapper-stop", tempSupervisor: null, adoptingSupervisor: null, host: f.host,
        });
      };
      const result = await runManualReadopt(f.input);
      expect(result.signaled, `${kind}/${fault}: ${JSON.stringify(result)}`).toBe(false);
      expect(result.injected).toBe(false);
      expect(f.tree.signals).toEqual([]);
      expect(f.counts).toEqual({ prepare: 1, guardian: 0, spawn: 0 });
    }
  });

  test("route target requires the stub main assignment even when modeld is ready", async () => {
    for (const kind of ["official route", "identity to route", "route profile refresh"] as const) {
      const f = await fixture(kind);
      f.input.models.assignments.main = null;
      const result = await runManualReadopt(f.input);
      expect(result.reason).toBe("missing_main_assignment");
      expect(result.signaled).toBe(false);
      expect(f.tree.signals).toEqual([]);
      expect(f.counts).toEqual({ prepare: 0, guardian: 0, spawn: 0 });
    }
  });

  test("manual confirmation does not admit a legacy ownership witness", async () => {
    const f = await fixture("identity to route");
    await expect(runManualReadopt({ ...f.input, legacyWitness: { identity: f.host } })).rejects.toMatchObject({ code: "invalid_usage" });
    expect(f.tree.signals).toEqual([]);
    expect(f.counts).toEqual({ prepare: 0, guardian: 0, spawn: 0 });
  });

  test("the non-public legacy cutover cannot skip next-target admission either", async () => {
    for (const fault of ["source", "capability"] as const) {
      const f = await fixture("stale identity");
      // This attestation was created by this fixture, inside the new isolated test root.
      await unlink(join(f.ephemeralRoot, "attestation.json"));
      if (fault === "source") f.source.text += "\n// unexpected bytes";
      else f.capability.strategy = "unavailable";
      const result = await runWatchdogCutover({ ...f.input, legacyWitness: { identity: f.host } });
      expect(result.signaled).toBe(false);
      expect(f.tree.signals).toEqual([]);
      expect(f.counts).toEqual({ prepare: 0, guardian: 0, spawn: 0 });
    }
  });

  test("H3 source facts cannot silently hash replacement characters for invalid UTF-8", async () => {
    const f = await fixture("official identity");
    const copy = join(f.root, "invalid-synthetic.cjs");
    await writeFile(copy, Buffer.concat([Buffer.from(SOURCE), Buffer.from([0xff])]));
    const target = createLiveH3AdoptPorts({
      markerPath: join(f.root, "marker.json"), overlayPath: join(f.root, "launch.json"),
      preloadNeedle: "/fixture/preload.cjs", execPath: process.execPath, hostBundle: copy,
    }).target!;
    expect(() => target.readSource()).toThrow("unsupported-host-encoding");
    expect(f.tree.signals).toEqual([]);
  });

  test("public manual wiring carries the same H3 source/capability checks, before environment capture", async () => {
    const f = await fixture("official identity");
    const copy = join(f.root, "synthetic-host.cjs");
    await writeFile(copy, SOURCE);
    // Only these read-only facts are taken from the real adapter. All process ports remain fake.
    const target = createLiveH3AdoptPorts({
      markerPath: join(f.root, "marker.json"), overlayPath: join(f.root, "launch.json"),
      preloadNeedle: "/fixture/preload.cjs", execPath: process.execPath, hostBundle: copy,
    }).target!;
    const strategy = target.launchStrategy(f.supervisor);
    expect(decideLivePreflight({ unique: { ok: true }, reviewed: { ok: true }, strategy }))
      .toEqual({ ok: false, code: "launch-strategy-unavailable" });
    const factory = spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts").mockImplementation(() => ({
      processes: f.tree, classify: f.input.classify!, target,
      waitHostGone: f.input.adopt!.waitGone, supervisorRelaunch: async () => null,
      waitReady: f.input.adopt!.waitReady, applyLaunchEnv: async () => { throw new Error("forbidden launch preparation"); },
      hasGrokboxPreload: f.input.adopt!.hasGrokboxPreload,
      spawnTempSupervisor: f.input.adopt!.spawnTempSupervisor, waitNewHost: f.input.adopt!.waitNewHost,
      readGatewayPid: f.input.adopt!.readGatewayPid,
    }));
    const env = spyOn(liveProc, "readNamedProcEnv").mockImplementation(() => { throw new Error("forbidden environment capture"); });
    try {
      const wired = wireLiveManualReadopt({ root: f.root, ephemeralRoot: f.ephemeralRoot, now: () => 10, mode: "identity" });
      expect(wired.adopt.target).toBe(target);
      expect(wired.freshDiskSha()).toBe(SHA);
      const result = await runManualReadopt({ ...f.input, ...wired, envHas: f.input.envHas });
      expect(result.reason).toBe("launch-strategy-unavailable");
      expect(result.signaled).toBe(false);
      expect(f.tree.signals).toEqual([]);
      expect(env).not.toHaveBeenCalled();
    } finally {
      env.mockRestore(); factory.mockRestore();
    }
  });
});
