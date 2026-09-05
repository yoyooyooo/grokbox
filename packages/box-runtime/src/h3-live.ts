import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { sha256Bytes } from "./hash.ts";
import {
  runH3OfflineDeactivate,
  runH3OfflineInject,
  type H3OfflinePorts,
} from "./h3-identity.ts";
import type { IdentityMarker, IdentityOpResult } from "./identity-op.ts";
import { IDENTITY_LAUNCH_ALLOWLIST } from "./launch-env.ts";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "./live-slices.ts";
import {
  inspectPid,
  linuxProcessPort,
  procEnvHas,
  readNamedProcEnv,
  roleOf,
} from "./live-proc.ts";
import { decideH3LaunchStrategy, type H3LaunchStrategy } from "./launch-strategy.ts";
import { findUniqueOfficialChain, loadReviewedProfile } from "./official-chain.ts";
import {
  countRoles,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process.ts";
import { profileFromSource, type PatchProfile } from "./transform.ts";

const EMPTY_CENSUS: Census = {
  wrapper: 0,
  supervisor: 0,
  host: 0,
  tempSupervisor: 0,
  guardian: 0,
  extras: 0,
};

export type LivePreflight = {
  ok: boolean;
  code?: string;
  signaled: false;
  diskSha: string;
  census: Census;
  unique: boolean;
  reviewedProfile: boolean;
  strategy: H3LaunchStrategy;
  nodeOptions: { wrapper: boolean; supervisor: boolean; host: boolean };
  grokboxPreload: { host: boolean };
  chain?: {
    wrapper: ProcessIdentity;
    supervisor: ProcessIdentity;
    host: ProcessIdentity;
  };
};

export type H3LiveSessionResult = {
  preflight: LivePreflight;
  injected: boolean;
  inject?: IdentityOpResult;
  deactivate?: IdentityOpResult;
};

export function decideLivePreflight(input: {
  unique: { ok: true } | { ok: false; code: string };
  reviewed: { ok: true } | { ok: false; code: string };
  strategy: H3LaunchStrategy;
}): { ok: true } | { ok: false; code: string } {
  if (!input.unique.ok) return { ok: false, code: input.unique.code };
  if (!input.reviewed.ok) return { ok: false, code: input.reviewed.code };
  if (input.strategy === "direct-overlay") return { ok: true };
  if (input.strategy === "transient-adopt-candidate") {
    return { ok: false, code: "transient-adopt-unwired" };
  }
  return { ok: false, code: "launch-strategy-unavailable" };
}

export function liveClassify(identity: ProcessIdentity): "wrapper" | "supervisor" | "host" | null {
  return roleOf(identity);
}

export function liveCensus(port: ProcessPort = linuxProcessPort()): Census {
  return countRoles(
    port.list().flatMap((ident) => {
      const role = liveClassify(ident);
      return role ? [{ ...ident, role }] : [];
    }),
  );
}

export function liveDiskSha(): string {
  return sha256Bytes(readFileSync(LIVE_HOST_BUNDLE));
}

async function waitUntil(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

function readMarkerFile(path: string): IdentityMarker | null {
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as IdentityMarker;
    if (
      typeof marker.operationId !== "string" ||
      typeof marker.pid !== "number" ||
      marker.mode !== "identity" ||
      marker.transformed !== true ||
      marker.compiled !== true ||
      marker.modeld !== false
    ) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

export function createLiveH3Ports(input: {
  markerPath: string;
  preloadNeedle: string;
  overlayPath: string;
}): H3OfflinePorts {
  const port = linuxProcessPort();
  return {
    processes: port,
    classify: liveClassify,
    waitHostGone: async (old) =>
      await waitUntil(() => {
        const observed = inspectPid(old.pid);
        return observed == null || observed.start !== old.start;
      }, 8000),
    supervisorRelaunch: async (supervisor) => {
      const ok = await waitUntil(() => {
        const host = port.list().find((ident) => liveClassify(ident) === "host");
        return Boolean(host && host.ppid === supervisor.pid && inspectPid(host.pid));
      }, 8000);
      if (!ok) return null;
      return port.list().find((ident) => liveClassify(ident) === "host" && ident.ppid === supervisor.pid) ?? null;
    },
    waitReady: async (hostPid) => {
      const ready = await waitUntil(() => {
        const marker = readMarkerFile(input.markerPath);
        return marker?.pid === hostPid && marker.compiled === true;
      }, 8000);
      return ready ? readMarkerFile(input.markerPath) : null;
    },
    applyLaunchEnv: async (env) => {
      const next = { ...env, GROKBOX_ALLOW_LIVE_HOST: "1" };
      await mkdir(dirname(input.overlayPath), { recursive: true, mode: 0o700 });
      await writeFile(input.overlayPath, `${JSON.stringify({ env: next })}\n`, { mode: 0o600 });
    },
    hasGrokboxPreload: (host) =>
      procEnvHas(host.pid, "NODE_OPTIONS", input.preloadNeedle) || procEnvHas(host.pid, "GROKBOX_PRELOAD_MODE", "identity"),
  };
}

export async function writeReviewedProfileFromCopy(destDir: string): Promise<{
  profilePath: string;
  profile: PatchProfile;
  sourceSha256: string;
  diskSha: string;
}> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const copyPath = join(destDir, "host-main.copy.cjs");
  const profilePath = join(destDir, "reviewed.json");
  await copyFile(LIVE_HOST_BUNDLE, copyPath);
  const source = await readFile(copyPath, "utf8");
  const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "live-h3-copy");
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  return {
    profilePath,
    profile,
    sourceSha256: profile.sourceSha256,
    diskSha: liveDiskSha(),
  };
}

export function preflightLiveH3(input: {
  reviewedProfilePath: string;
  processes?: ProcessPort;
}): LivePreflight {
  const port = input.processes ?? linuxProcessPort();
  let diskSha = "";
  try {
    diskSha = liveDiskSha();
  } catch {
    diskSha = "";
  }
  const census = liveCensus(port);
  const unique = findUniqueOfficialChain(port, liveClassify);
  let reviewed: { ok: true } | { ok: false; code: string } = { ok: false, code: "unreviewed-profile" };
  if (existsSync(input.reviewedProfilePath) && diskSha.length > 0) {
    try {
      const profile = JSON.parse(readFileSync(input.reviewedProfilePath, "utf8")) as PatchProfile;
      reviewed = loadReviewedProfile(profile, diskSha);
    } catch {
      reviewed = { ok: false, code: "unreviewed-profile" };
    }
  }
  const strategy = unique.ok
    ? decideH3LaunchStrategy({ supervisor: unique.chain.supervisor })
    : "unavailable";
  const decision = decideLivePreflight({ unique, reviewed, strategy });
  const chain = unique.ok ? unique.chain : undefined;
  const presenceOf = (pid: number | undefined) => ({
    nodeOptions: pid != null && procEnvHas(pid, "NODE_OPTIONS"),
    preload: pid != null && (procEnvHas(pid, "NODE_OPTIONS", "grokbox") || procEnvHas(pid, "GROKBOX_PRELOAD_MODE")),
  });
  const wrapperP = presenceOf(chain?.wrapper.pid);
  const supervisorP = presenceOf(chain?.supervisor.pid);
  const hostP = presenceOf(chain?.host.pid);
  return {
    ok: decision.ok,
    code: decision.ok ? undefined : decision.code,
    signaled: false,
    diskSha,
    census,
    unique: unique.ok,
    reviewedProfile: reviewed.ok,
    strategy,
    nodeOptions: {
      wrapper: wrapperP.nodeOptions,
      supervisor: supervisorP.nodeOptions,
      host: hostP.nodeOptions,
    },
    grokboxPreload: { host: hostP.preload },
    chain,
  };
}

export async function runH3LiveIdentitySession(input: {
  ephemeralRoot?: string;
  reviewedProfilePath: string;
  preloadPath: string;
  execPath?: string;
  hostBundle?: string;
  operationId?: string;
}): Promise<H3LiveSessionResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const markerPath = join(ephemeralRoot, "state", "preload-marker.json");
  const overlayPath = join(ephemeralRoot, "state", "launch-env.json");
  await mkdir(join(ephemeralRoot, "state"), { recursive: true, mode: 0o700 });
  const preflight = preflightLiveH3({ reviewedProfilePath: input.reviewedProfilePath });
  if (!preflight.ok) {
    return { preflight, injected: false };
  }
  const ports = createLiveH3Ports({
    markerPath,
    preloadNeedle: input.preloadPath,
    overlayPath,
  });
  const host = preflight.chain!.host;
  const launchSource = readNamedProcEnv(host.pid, IDENTITY_LAUNCH_ALLOWLIST);
  const inject = await runH3OfflineInject({
    ephemeralRoot,
    reviewedProfilePath: input.reviewedProfilePath,
    diskSha: liveDiskSha,
    operationId: input.operationId ?? `h3-live-${Date.now()}`,
    execPath: input.execPath ?? (existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath),
    preloadPath: input.preloadPath,
    hostBundle: input.hostBundle ?? LIVE_HOST_BUNDLE,
    markerPath,
    launchSource,
    ports,
  });
  if (!inject.ok) {
    return { preflight, injected: true, inject };
  }
  const deactivate = await runH3OfflineDeactivate({
    ephemeralRoot,
    diskSha: liveDiskSha,
    ports,
  });
  return { preflight, injected: true, inject, deactivate };
}

export function emptyLiveCensus(): Census {
  return { ...EMPTY_CENSUS };
}
