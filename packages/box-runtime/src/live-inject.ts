import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { armGuardian } from "./guardian.ts";
import { sha256Bytes } from "./hash.ts";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "./live-slices.ts";
import { findRole, linuxProcessPort, readEnviron, roleOf } from "./live-proc.ts";
import {
  countRoles,
  signalIfMatch,
  singleOfficialChain,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process.ts";
import { profileFromSource } from "./transform.ts";
import { clearAttestation, writeAttestation } from "./attestation.ts";
import { appendEvent } from "./events.ts";

const NODE = "/exec-daemon/node";
const HOST_DIR = "/home/box/sand-host";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type LiveIdentityResult = {
  ok: boolean;
  recoveryRequired: boolean;
  code?: string;
  diskShaBefore: string;
  diskShaAfter: string;
  census: Census;
  coverage: "none" | "attested" | "window-open";
  hostPid?: number;
  marker?: { mode?: string; transformed?: boolean; modeld?: boolean };
};

export type IdentityChainContext = {
  processes: ProcessPort;
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
  diskSha: () => string;
  roles: () => Array<ProcessIdentity & { role: string }>;
  spawnHost: () => ProcessIdentity;
  readMarker: () => { mode?: string; transformed?: boolean; modeld?: boolean } | undefined;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now: () => number;
  persist?: (host: ProcessIdentity, sha: string) => Promise<void>;
};

function censusOf(ctx: IdentityChainContext): Census {
  return countRoles(ctx.roles().filter((row) => ctx.processes.inspect(row.pid) !== null));
}

/** Fake-tree and live share this protocol. Does not open /proc by itself. */
export async function runIdentityChainInject(ctx: IdentityChainContext): Promise<LiveIdentityResult> {
  const shaBefore = ctx.diskSha();
  const fail = (code: string, recoveryRequired = true): LiveIdentityResult => ({
    ok: false,
    recoveryRequired,
    code,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: censusOf(ctx),
    coverage: "window-open",
  });

  const guardianWrapper = armGuardian({
    wrapper: ctx.wrapper,
    processes: ctx.processes,
    deadlineMs: 5_000,
    now: ctx.now,
    wait: ctx.wait,
  });
  const guardianSupervisor = armGuardian({
    wrapper: ctx.supervisor,
    processes: ctx.processes,
    deadlineMs: 5_000,
    now: ctx.now,
    wait: ctx.wait,
  });
  const contAll = () => {
    guardianSupervisor.close();
    guardianWrapper.close();
  };

  try {
    if (!signalIfMatch(ctx.processes, ctx.wrapper, "SIGSTOP").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    if (!signalIfMatch(ctx.processes, ctx.supervisor, "SIGSTOP").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    if (ctx.diskSha() !== shaBefore) {
      contAll();
      return fail("disk-sha-changed");
    }
    if (!signalIfMatch(ctx.processes, ctx.host, "SIGTERM").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    const spawned = ctx.spawnHost();
    const marker = ctx.readMarker();
    if (marker?.transformed !== true || marker.mode !== "identity" || marker.modeld !== false) {
      contAll();
      return fail("marker-missing");
    }
    signalIfMatch(ctx.processes, ctx.supervisor, "SIGCONT");
    signalIfMatch(ctx.processes, ctx.wrapper, "SIGCONT");
    contAll();

    const shaAfter = ctx.diskSha();
    const census = censusOf(ctx);
    if (shaAfter !== shaBefore) return { ...fail("disk-sha-changed"), diskShaAfter: shaAfter, census };
    if (!singleOfficialChain(census)) return { ...fail("census-invalid"), diskShaAfter: shaAfter, census, hostPid: spawned.pid, marker };
    await ctx.persist?.(spawned, shaAfter);
    return {
      ok: true,
      recoveryRequired: false,
      diskShaBefore: shaBefore,
      diskShaAfter: shaAfter,
      census,
      coverage: "attested",
      hostPid: spawned.pid,
      marker,
    };
  } catch (error) {
    contAll();
    return fail(error instanceof Error ? error.message : "inject-error");
  }
}

async function liveDiskSha(): Promise<string> {
  return sha256Bytes(await readFile(LIVE_HOST_BUNDLE));
}

function liveCensus(): Census {
  const port = linuxProcessPort();
  return countRoles(
    port.list().flatMap((ident) => {
      const role = roleOf(ident);
      return role ? [{ ...ident, role }] : [];
    }),
  );
}

/** Linux adapter. Must not be called until identity-chain fake tests pass. */
export async function runLiveIdentityInject(input: { root: string; preloadPath: string }): Promise<LiveIdentityResult> {
  if (process.env.GROKBOX_ALLOW_LIVE_HOST !== "1") {
    return {
      ok: false,
      recoveryRequired: false,
      code: "live-host-blocked",
      diskShaBefore: "",
      diskShaAfter: "",
      census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
      coverage: "none",
    };
  }
  const port = linuxProcessPort();
  const shaBefore = await liveDiskSha();
  const wrapper = findRole(port, "wrapper");
  const supervisor = findRole(port, "supervisor");
  const host = findRole(port, "host");
  if (!wrapper || !supervisor || !host) {
    return {
      ok: false,
      recoveryRequired: true,
      code: "census-invalid",
      diskShaBefore: shaBefore,
      diskShaAfter: shaBefore,
      census: liveCensus(),
      coverage: "window-open",
    };
  }

  const source = await readFile(LIVE_HOST_BUNDLE, "utf8");
  const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "live-identity");
  await mkdir(join(input.root, "profiles"), { recursive: true, mode: 0o700 });
  await mkdir(join(input.root, "state"), { recursive: true, mode: 0o700 });
  const profilePath = join(input.root, "profiles", `${shaBefore}.json`);
  const markerPath = join(input.root, "state", "preload-marker.json");
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });

  const hostEnv = readEnviron(host.pid);
  let spawnedPid: number | undefined;
  return await runIdentityChainInject({
    processes: port,
    wrapper,
    supervisor,
    host,
    diskSha: () => sha256Bytes(readFileSync(LIVE_HOST_BUNDLE)),
    roles: () =>
      port.list().flatMap((ident) => {
        const role = roleOf(ident);
        return role ? [{ ...ident, role }] : [];
      }),
    spawnHost: () => {
      hostEnv.NODE_OPTIONS = `--require=${input.preloadPath}`;
      hostEnv.GROKBOX_ALLOW_LIVE_HOST = "1";
      hostEnv.GROKBOX_HOST_BUNDLE = LIVE_HOST_BUNDLE;
      hostEnv.GROKBOX_PATCH_PROFILE = profilePath;
      hostEnv.GROKBOX_PRELOAD_MODE = "identity";
      hostEnv.GROKBOX_PRELOAD_MARKER = markerPath;
      const child = spawn(NODE, [LIVE_HOST_BUNDLE], {
        cwd: HOST_DIR,
        detached: true,
        stdio: "ignore",
        env: hostEnv,
      });
      child.unref();
      spawnedPid = child.pid;
      if (child.pid == null) throw new Error("spawn-failed");
      return { pid: child.pid, uid: host.uid, start: Date.now(), exe: host.exe, cmdline: [NODE, LIVE_HOST_BUNDLE], ppid: 1, ancestry: [1] };
    },
    readMarker: () => {
      try {
        return JSON.parse(readFileSync(markerPath, "utf8")) as { mode?: string; transformed?: boolean; modeld?: boolean };
      } catch {
        return undefined;
      }
    },
    wait: async (ms, signal) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (signal?.aborted) return false;
        await sleep(50);
      }
      return !signal?.aborted;
    },
    now: () => Date.now(),
    persist: async (newHost, sha) => {
      await writeAttestation(input.root, {
        mode: "identity",
        coverage: "attested",
        diskSha: sha,
        pid: newHost.pid,
        start: newHost.start,
        identity: newHost,
        at: new Date().toISOString(),
        modeld: false,
      });
      await appendEvent(input.root, {
        name: "inject_phase",
        at: new Date().toISOString(),
        phase: "identity",
        outcome: "attested",
        pid: newHost.pid,
        sha,
      });
    },
  });
}

export async function runLiveIdentityDeactivate(input: { root: string }): Promise<LiveIdentityResult> {
  if (process.env.GROKBOX_ALLOW_LIVE_HOST !== "1") {
    return {
      ok: false,
      recoveryRequired: false,
      code: "live-host-blocked",
      diskShaBefore: "",
      diskShaAfter: "",
      census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
      coverage: "none",
    };
  }
  const shaBefore = await liveDiskSha();
  const port = linuxProcessPort();
  const { readAttestation } = await import("./attestation.ts");
  const attestation = await readAttestation(input.root);
  if (attestation) {
    signalIfMatch(port, attestation.identity, "SIGTERM");
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const observed = port.inspect(attestation.identity.pid);
      if (!observed || observed.start !== attestation.identity.start) break;
      await sleep(200);
    }
  }
  await clearAttestation(input.root);
  const shaAfter = await liveDiskSha();
  const census = liveCensus();
  const ok = shaAfter === shaBefore && singleOfficialChain(census);
  return {
    ok,
    recoveryRequired: !ok,
    code: ok ? undefined : "deactivate-failed",
    diskShaBefore: shaBefore,
    diskShaAfter: shaAfter,
    census,
    coverage: "none",
  };
}
