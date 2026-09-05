import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAttestation } from "../src/attestation.ts";
import { runH3OfflineAdopt, runH3OfflineAdoptDeactivate } from "../src/h3-identity.ts";
import { armGuardian } from "../src/guardian.ts";
import { sha256Bytes } from "../src/hash.ts";
import { inspectPid, linuxProcessPort, readEnviron } from "../src/live-proc.ts";
import {
  findAdoptedHostState,
  findUniqueOfficialChain,
  proveStableOfficialState,
} from "../src/official-chain.ts";
import {
  canHandoffAdopt,
  officialWouldSpawn,
  readAdoptOpState,
  runTransientAdoptDeactivate,
  runTransientAdoptOperation,
} from "../src/transient-adopt.ts";
import { profileFromSource, type PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const reviewed: PatchProfile = {
  profileId: "reviewed",
  sourceSha256: "sha-reviewed",
  transformedSourceSha256: "sha-transformed",
  slices: [
    { id: "create-session", startAnchor: "a", endAnchor: "b", find: "c", replacement: "d" },
    { id: "agent-id", startAnchor: "e", endAnchor: "f", find: "g", replacement: "h" },
  ],
};

const WRAPPER_SRC = fileURLToPath(new URL("./fixtures/disposable-adopt-wrapper.cjs", import.meta.url));
const SUPERVISOR_SRC = fileURLToPath(new URL("./fixtures/disposable-adopt-supervisor.cjs", import.meta.url));
const TEMP_SRC = fileURLToPath(new URL("./fixtures/disposable-temp-supervisor.cjs", import.meta.url));
const HOST_SRC = fileURLToPath(new URL("./fixtures/disposable-host.cjs", import.meta.url));
const PRELOAD_SRC = fileURLToPath(new URL("../src/preload.ts", import.meta.url));
const ADOPT_SRC = fileURLToPath(new URL("../src/transient-adopt.ts", import.meta.url));
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
const FORBIDDEN = "sk-forbidden-acme";

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

async function waitUntil(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

describe("adopted topology proof is not PPID parentage", () => {
  test("findUniqueOfficialChain stays strict; adopted proof requires orphan Host", () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    expect(findUniqueOfficialChain(tree, classify(tree)).ok).toBe(true);

    tree.signal(host, "SIGTERM");
    const orphan = tree.spawn("host");
    expect(orphan.ppid).toBe(1);
    expect(findUniqueOfficialChain(tree, classify(tree))).toMatchObject({ ok: false, code: "bad-parentage" });
    const adopted = findAdoptedHostState(tree, classify(tree), {
      gatewayPid: orphan.pid,
      expectedHost: orphan,
    });
    expect(adopted.ok).toBe(true);
    if (adopted.ok) {
      expect(adopted.state.host.ppid).not.toBe(adopted.state.supervisor.pid);
    }
    expect(
      findAdoptedHostState(tree, classify(tree), { gatewayPid: host.pid }),
    ).toMatchObject({ ok: false, code: "gateway-mismatch" });

    const childTree = new FakeProcessTree();
    const w = childTree.spawn("wrapper");
    const s = childTree.spawn("supervisor", { parent: w });
    const h = childTree.spawn("host", { parent: s });
    expect(
      findAdoptedHostState(childTree, classify(childTree), { gatewayPid: h.pid, expectedHost: h }),
    ).toMatchObject({ ok: false, code: "still-supervisor-child" });
    expect(proveStableOfficialState(childTree, classify(childTree)).ok).toBe(true);
  });

  test("transient-adopt module never SIGKILLs official processes", async () => {
    const src = await readFile(ADOPT_SRC, "utf8");
    expect(src).not.toMatch(/SIGKILL/);
    expect(src).toContain("SIGTERM");
    expect(src).toContain("SIGSTOP");
  });

  test("stale gateway means official supervisor would spawn; handoff is forbidden", () => {
    expect(canHandoffAdopt({ gatewayPid: 9, hostPid: 9, hostAlive: true })).toBe(true);
    expect(canHandoffAdopt({ gatewayPid: 8, hostPid: 9, hostAlive: true })).toBe(false);
    expect(canHandoffAdopt({ gatewayPid: 9, hostPid: 9, hostAlive: false })).toBe(false);
    expect(
      officialWouldSpawn({ gatewayPid: 1514327, identityHostPid: 2693924, identityHostAlive: true }),
    ).toBe(true);
    expect(
      officialWouldSpawn({ gatewayPid: 2693924, identityHostPid: 2693924, identityHostAlive: true }),
    ).toBe(false);
  });
});

describe("transient-adopt fake tree", () => {
  test("orphan Host is attested; PPID is not the new supervisor; drift and injector death do not attest", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const root = await mkdtemp(join(tmpdir(), "grokbox-adopt-"));
    let patchedPid = 0;
    let gatewayPid: number | null = null;

    const result = await runTransientAdoptOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: root,
      operationId: "adopt-ok",
      readMarker: () => null,
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReady: async (pid) => ({
        operationId: "adopt-ok",
        pid,
        mode: "identity",
        transformed: true,
        compiled: true,
        modeld: false,
      }),
      spawnTempSupervisor: async () => {
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        patchedPid = born.pid;
        gatewayPid = born.pid;
        return temp;
      },
      waitNewHost: async (oldPid) => tree.list().find((ident) => classify(tree)(ident) === "host" && ident.pid !== oldPid) ?? null,
      readGatewayPid: () => gatewayPid,
      armGuardian: async (frozen) =>
        guard(tree, frozen, () => {
          if (!tree.roles().some((row) => row.role === "supervisor")) {
            tree.spawn("supervisor", { parent: wrapper });
          }
        }),
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      now: () => 10,
    });
    expect(result.code ?? "ok").toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe("attested");
    expect(result.launchMode).toBe("transient-adopt");
    expect(result.recoveryRequired).toBe(false);
    expect(result.host?.ppid).not.toBe(result.host ? tree.roles().find((row) => row.role === "supervisor")?.pid : -1);
    expect(findUniqueOfficialChain(tree, classify(tree))).toMatchObject({ ok: false, code: "bad-parentage" });
    const adopted = findAdoptedHostState(tree, classify(tree), {
      gatewayPid,
      expectedHost: result.host,
    });
    expect(adopted.ok).toBe(true);
    if (adopted.ok) expect(adopted.state.host.ppid).not.toBe(adopted.state.supervisor.pid);
    expect(tree.alive(host.pid)).toBe(false);
    expect(tree.stopped(wrapper.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);

    const deactivated = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-de-")),
      attestation: { identity: result.host!, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => {
        const sup = tree.roles().find((row) => row.role === "supervisor");
        const born = tree.spawn("host", { parent: sup });
        gatewayPid = born.pid;
        return born;
      },
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => gatewayPid,
      clearAttestation: async () => undefined,
    });
    expect(deactivated.code ?? "ok").toBe("ok");
    expect(deactivated.ok).toBe(true);
    expect(deactivated.host?.ppid).toBe(tree.roles().find((row) => row.role === "supervisor")?.pid);
    expect(findUniqueOfficialChain(tree, classify(tree)).ok).toBe(true);

    const driftTree = new FakeProcessTree();
    const dw = driftTree.spawn("wrapper");
    const ds = driftTree.spawn("supervisor", { parent: dw });
    driftTree.spawn("host", { parent: ds });
    let sha = "sha-reviewed";
    const drifted = await runTransientAdoptOperation({
      processes: driftTree,
      classify: classify(driftTree),
      reviewedProfile: reviewed,
      diskSha: () => (driftTree.stopped(dw.pid) ? "sha-drift" : sha),
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-drift-")),
      operationId: "adopt-drift",
      readMarker: () => null,
      waitGone: async () => true,
      waitReady: async () => null,
      spawnTempSupervisor: async () => null,
      waitNewHost: async () => null,
      readGatewayPid: () => null,
      armGuardian: async (frozen) => guard(driftTree, frozen),
      hasGrokboxPreload: () => false,
      now: () => 0,
    });
    expect(drifted).toMatchObject({
      ok: false,
      code: "disk-sha-changed",
      recoveryRequired: true,
      coverage: "window-open",
    });
    expect(drifted.coverage).not.toBe("attested");
    expect(driftTree.stopped(dw.pid)).toBe(false);

    const crashTree = new FakeProcessTree();
    const cw = crashTree.spawn("wrapper");
    const cs = crashTree.spawn("supervisor", { parent: cw });
    crashTree.spawn("host", { parent: cs });
    const crashed = await runTransientAdoptOperation({
      processes: crashTree,
      classify: classify(crashTree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-crash-")),
      operationId: "adopt-crash",
      readMarker: () => null,
      waitGone: async () => true,
      waitReady: async () => null,
      prepareTempLaunch: async () => {
        throw new Error("injector-dead");
      },
      spawnTempSupervisor: async () => null,
      waitNewHost: async () => null,
      readGatewayPid: () => null,
      armGuardian: async (frozen) => guard(crashTree, frozen),
      hasGrokboxPreload: () => false,
      now: () => 0,
    });
    expect(crashed).toMatchObject({
      ok: false,
      recoveryRequired: true,
      code: "injector-dead",
    });
    expect(crashed.coverage).not.toBe("attested");
    expect(crashTree.stopped(cw.pid)).toBe(false);
  });

  test("stale gateway aborts before CONT handoff so official cannot spawn a competitor", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const staleGateway = host.pid;
    let patchedPid = 0;
    const result = await runTransientAdoptOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-race-")),
      operationId: "adopt-race",
      readMarker: () => null,
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReady: async (pid) => ({
        operationId: "adopt-race",
        pid,
        mode: "identity",
        transformed: true,
        compiled: true,
        modeld: false,
      }),
      spawnTempSupervisor: async () => {
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        patchedPid = born.pid;
        return temp;
      },
      waitNewHost: async (oldPid) =>
        tree.list().find((ident) => classify(tree)(ident) === "host" && ident.pid !== oldPid) ?? null,
      readGatewayPid: () => staleGateway,
      armGuardian: async (frozen) =>
        guard(tree, frozen, () => {
          if (!tree.roles().some((row) => row.role === "supervisor")) {
            tree.spawn("supervisor", { parent: wrapper });
          }
        }),
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      now: () => 10,
      adoptProveMs: 20,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "gateway-unproven",
      recoveryRequired: true,
    });
    expect(result.coverage).not.toBe("attested");
    expect(tree.alive(patchedPid)).toBe(false);
    expect(tree.stopped(wrapper.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    expect(tree.signals.some((row) => row.pid === wrapper.pid && row.signal === "SIGCONT")).toBe(true);
  });

  test("journals phase before signals and does not TERM a competitor Host", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    tree.spawn("host", { parent: supervisor });
    const root = await mkdtemp(join(tmpdir(), "grokbox-adopt-own-"));
    const competitor = { pid: 0 };
    const result = await runTransientAdoptOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: root,
      operationId: "adopt-own",
      readMarker: () => null,
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReady: async (pid) => ({
        operationId: "adopt-own",
        pid,
        mode: "identity",
        transformed: true,
        compiled: true,
        modeld: false,
      }),
      spawnTempSupervisor: async () => {
        const extra = tree.spawn("host");
        competitor.pid = extra.pid;
        const temp = tree.spawn("temp-supervisor");
        tree.spawn("host", { parent: temp });
        return temp;
      },
      waitNewHost: async (oldPid) =>
        tree.list().find((ident) => classify(tree)(ident) === "host" && ident.pid !== oldPid) ?? null,
      readGatewayPid: () => null,
      armGuardian: async (frozen) => guard(tree, frozen),
      hasGrokboxPreload: () => true,
      now: () => 10,
      adoptProveMs: 20,
    });
    expect(result).toMatchObject({ ok: false, code: "competitor-host", recoveryRequired: true });
    expect(tree.alive(competitor.pid)).toBe(true);
    expect(tree.signals.some((row) => row.pid === competitor.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
    const journal = await readAdoptOpState(root);
    expect(journal?.phase).toBeDefined();
    expect(journal?.phase).not.toBe("attested");
  });

  test("deactivate refuses a non-direct official midpoint", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host");
    let gatewayPid: number | null = host.pid;
    const result = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-mid-")),
      attestation: { identity: host, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => {
        const orphan = tree.spawn("host");
        gatewayPid = orphan.pid;
        return orphan;
      },
      hasGrokboxPreload: (ident) => ident.pid === host.pid,
      readGatewayPid: () => gatewayPid,
      clearAttestation: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.signaled).toBe(true);
    expect(result.code).toBe("census-invalid");
    expect(findUniqueOfficialChain(tree, classify(tree)).ok).toBe(false);
  });

  test("deactivate may relax only attestation-vs-live SHA when allowed", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host");
    let gatewayPid: number | null = host.pid;
    const blocked = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-live-now",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-stale-block-")),
      attestation: { identity: host, diskSha: "sha-old-att" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => {
        const born = tree.spawn("host", { parent: supervisor });
        gatewayPid = born.pid;
        return born;
      },
      hasGrokboxPreload: (ident) => ident.pid === host.pid,
      readGatewayPid: () => gatewayPid,
      clearAttestation: async () => undefined,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.signaled).toBe(false);
    expect(blocked.code).toBe("disk-sha-changed");
    expect(tree.alive(host.pid)).toBe(true);
    expect(tree.signals).toEqual([]);

    const allowed = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-live-now",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-adopt-stale-ok-")),
      attestation: { identity: host, diskSha: "sha-old-att" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => {
        const born = tree.spawn("host", { parent: supervisor });
        gatewayPid = born.pid;
        return born;
      },
      hasGrokboxPreload: (ident) => ident.pid === host.pid,
      readGatewayPid: () => gatewayPid,
      clearAttestation: async () => undefined,
      allowStaleAttestedSha: true,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.signaled).toBe(true);
    expect(tree.alive(host.pid)).toBe(false);
    expect(findUniqueOfficialChain(tree, classify(tree)).ok).toBe(true);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
  });
});

describeLinux("disposable Linux orphan-adopt fixture", () => {
  test("temp supervisor dies; fresh official adopts same Host; final PPID is not the new supervisor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-adopt-linux-"));
    const wrapperPath = join(dir, "disposable-adopt-wrapper.cjs");
    const supervisorPath = join(dir, "disposable-adopt-supervisor.cjs");
    const tempPath = join(dir, "disposable-temp-supervisor.cjs");
    const initialHost = join(dir, "disposable-host.cjs");
    const pidFile = join(dir, "host.pid");
    const specFile = join(dir, "launch.json");
    const gatewayFile = join(dir, "gateway.json");
    const copyPath = join(dir, "host-main.cjs");
    const profilePath = join(dir, "reviewed.json");
    const markerPath = join(dir, "marker.json");
    const preloadPath = join(dir, "preload.cjs");
    await copyFile(WRAPPER_SRC, wrapperPath);
    await copyFile(SUPERVISOR_SRC, supervisorPath);
    await copyFile(TEMP_SRC, tempPath);
    await copyFile(HOST_SRC, initialHost);
    const runningHost = `${SYNTHETIC_HOST}\nsetInterval(() => {}, 1000);\n`;
    await writeFile(copyPath, runningHost);
    const profile = profileFromSource(runningHost, SYNTHETIC_SLICES, "reviewed-adopt");
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    await writeFile(specFile, `${JSON.stringify({ argv: [initialHost] })}\n`);
    const built = Bun.spawn(
      ["bun", "build", PRELOAD_SRC, "--outfile", preloadPath, "--target", "node", "--format", "cjs"],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    expect(await built.exited).toBe(0);

    const wrapperProc: ChildProcess = spawn(
      NODE,
      [wrapperPath, supervisorPath, initialHost, pidFile, specFile, gatewayFile],
      { stdio: "ignore", env: { ...process.env, ACME_KEY: FORBIDDEN } },
    );
    const classifyLinux = (ident: { cmdline: readonly string[] }) => {
      const line = ident.cmdline.join(" ");
      if (line.includes("/home/box/sand-host")) return null;
      if (line.includes("sand-supervisor.mjs") || line.includes("supervise-sand-supervisor")) return null;
      if (!line.includes(dir)) return null;
      if (line.includes("disposable-adopt-wrapper.cjs")) return "wrapper" as const;
      if (line.includes("disposable-adopt-supervisor.cjs")) return "supervisor" as const;
      if (line.includes("disposable-temp-supervisor.cjs")) return "temp-supervisor" as const;
      if (line.includes("disposable-host.cjs") || line.includes("host-main.cjs")) return "host" as const;
      return null;
    };
    const killTree = async () => {
      try {
        if (wrapperProc.pid) process.kill(wrapperProc.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      for (const ident of linuxProcessPort().list()) {
        if (classifyLinux(ident)) {
          try {
            process.kill(ident.pid, "SIGTERM");
          } catch {
            /* ignore */
          }
        }
      }
    };
    try {
      const port = linuxProcessPort();
      expect(
        await waitUntil(() => {
          const unique = findUniqueOfficialChain(port, classifyLinux);
          return unique.ok;
        }),
      ).toBe(true);
      const first = findUniqueOfficialChain(port, classifyLinux);
      expect(first.ok).toBe(true);
      const firstPid = first.ok ? first.chain.host.pid : 0;
      const diskSha = () => sha256Bytes(require("node:fs").readFileSync(copyPath));
      expect(diskSha()).toBe(profile.sourceSha256);

      const ports = {
        processes: port,
        classify: classifyLinux,
        waitHostGone: async (old: { pid: number; start: number }) =>
          await waitUntil(() => inspectPid(old.pid)?.start !== old.start),
        supervisorRelaunch: async () => null,
        waitReady: async (pid: number) => {
          const ready = await waitUntil(async () => {
            try {
              const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pid?: number; compiled?: boolean };
              return marker.pid === pid && marker.compiled === true;
            } catch {
              return false;
            }
          }, 8000);
          if (!ready) return null;
          return JSON.parse(await readFile(markerPath, "utf8"));
        },
        applyLaunchEnv: async (env: Record<string, string>) => {
          await writeFile(specFile, `${JSON.stringify({ argv: [copyPath], env, replaceEnv: true })}\n`);
        },
        hasGrokboxPreload: (host: { pid: number }) => {
          try {
            return (readEnviron(host.pid).NODE_OPTIONS ?? "").includes(preloadPath);
          } catch {
            return false;
          }
        },
        spawnTempSupervisor: async () => {
          spawn(NODE, [tempPath, copyPath, pidFile, specFile, gatewayFile], { stdio: "ignore" });
          expect(
            await waitUntil(() => port.list().some((ident) => classifyLinux(ident) === "temp-supervisor")),
          ).toBe(true);
          return port.list().find((ident) => classifyLinux(ident) === "temp-supervisor") ?? null;
        },
        waitNewHost: async (oldPid: number) => {
          expect(
            await waitUntil(() => {
              const host = port.list().find((ident) => classifyLinux(ident) === "host");
              return Boolean(host && host.pid !== oldPid && inspectPid(host.pid));
            }, 8000),
          ).toBe(true);
          return port.list().find((ident) => classifyLinux(ident) === "host" && ident.pid !== oldPid) ?? null;
        },
        readGatewayPid: () => {
          try {
            const pid = Number(JSON.parse(require("node:fs").readFileSync(gatewayFile, "utf8")).pid);
            return Number.isInteger(pid) && pid > 0 ? pid : null;
          } catch {
            return null;
          }
        },
      };

      const result = await runH3OfflineAdopt({
        ephemeralRoot: dir,
        reviewedProfilePath: profilePath,
        diskSha,
        operationId: "linux-adopt",
        execPath: NODE,
        preloadPath,
        hostBundle: copyPath,
        markerPath,
        launchSource: {
          ...process.env,
          ACME_KEY: FORBIDDEN,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        ports,
      });
      expect(result.code ?? "ok").toBe("ok");
      expect(result.ok).toBe(true);
      expect(result.launchMode).toBe("transient-adopt");
      expect(result.host?.pid).not.toBe(firstPid);
      expect(result.host).toBeTruthy();
      const uniqueAfter = findUniqueOfficialChain(port, classifyLinux);
      expect(uniqueAfter.ok).toBe(false);
      expect(uniqueAfter.ok ? null : uniqueAfter.code).toBe("bad-parentage");
      const adopted = findAdoptedHostState(port, classifyLinux, {
        gatewayPid: ports.readGatewayPid(),
        expectedHost: result.host,
      });
      expect(adopted.ok).toBe(true);
      if (!adopted.ok || !result.host) throw new Error("adopt unproven");
      expect(adopted.state.host.pid).toBe(result.host.pid);
      expect(adopted.state.host.ppid).not.toBe(adopted.state.supervisor.pid);
      expect(ports.hasGrokboxPreload(result.host)).toBe(true);
      expect(ports.hasGrokboxPreload(adopted.state.supervisor)).toBe(false);
      expect(readEnviron(result.host.pid).ACME_KEY).not.toBe(FORBIDDEN);
      const record = await readAttestation(dir);
      expect(record).toMatchObject({
        mode: "identity",
        coverage: "attested",
        launchMode: "transient-adopt",
        modeld: false,
        diskSha: diskSha(),
      });

      await writeFile(
        specFile,
        `${JSON.stringify({ argv: [initialHost], env: { PATH: process.env.PATH }, replaceEnv: true })}\n`,
      );
      const deactivated = await runH3OfflineAdoptDeactivate({
        ephemeralRoot: dir,
        diskSha,
        ports,
      });
      expect(deactivated.code ?? "ok").toBe("ok");
      expect(deactivated.ok).toBe(true);
      expect(deactivated.host?.pid).not.toBe(result.host.pid);
      expect(ports.hasGrokboxPreload(deactivated.host!)).toBe(false);
      expect(await readAttestation(dir)).toBeNull();
    } finally {
      await killTree();
    }
  }, 30_000);
});
