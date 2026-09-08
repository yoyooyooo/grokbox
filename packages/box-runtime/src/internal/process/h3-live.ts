import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ephemeralRuntimeRoot } from "../io/ephemeral.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import {
  runH3OfflineAdopt,
  runH3OfflineAdoptDeactivate,
  runH3OfflineDeactivate,
  runH3OfflineInject,
  type H3AdoptPorts,
  type H3OfflinePorts,
} from "./h3-identity.ts";
import type { IdentityMarker, IdentityOpResult } from "./identity-op.ts";
import { fillMissingLaunchEnv, IDENTITY_LAUNCH_ALLOWLIST } from "./launch.node.ts";
import { LIVE_HOST_BUNDLE } from "../host/live-slices.ts";
import {
  inspectPid,
  linuxProcessPort,
  procEnvHas,
  readNamedProcEnv,
  roleOf,
} from "./linux.node.ts";
import { decideH3LaunchStrategy, type H3LaunchStrategy } from "./launch-strategy.ts";
import { resolveRuntimeHelper, RUNTIME_HELPER_TEMP_SUPERVISOR } from "./helpers/runtime-helpers.ts";
import { findUniqueOfficialChain, loadReviewedProfile } from "./official-chain.ts";
import {
  countRoles,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process-port.ts";
import type { PatchProfile } from "../host/profile.ts";
import { validateReviewedProfile } from "./profile.node.ts";
export { writeReviewedProfileFromCopy, type WriteReviewedProfileFromCopyInput } from "./profile.node.ts";

const EMPTY_CENSUS: Census = {
  wrapper: 0,
  supervisor: 0,
  host: 0,
  tempSupervisor: 0,
  guardian: 0,
  extras: 0,
};

const TEMP_SUPERVISOR = resolveRuntimeHelper(RUNTIME_HELPER_TEMP_SUPERVISOR);
const LIVE_GATEWAY_JSON = "/home/box/sand-data/gateway.json";
const LIVE_WAIT_MS = 30_000;

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
  if (input.strategy === "transient-adopt-candidate") return { ok: true };
  return { ok: false, code: "launch-strategy-unavailable" };
}

export function reviewOfficialAdoptCapability(supervisor: ProcessIdentity): boolean {
  const line = supervisor.cmdline.join(" ");
  if (!line.includes("sand-supervisor.mjs")) return false;
  const supervisorPath =
    supervisor.cmdline.find((part) => part.includes("sand-supervisor.mjs") && part.startsWith("/")) ??
    "/usr/local/bin/sand-supervisor.mjs";
  try {
    const src = readFileSync(supervisorPath, "utf8");
    return (
      src.includes("maybeAdoptOrphanHost") &&
      src.includes("adopting live orphan host") &&
      src.includes("detached: true") &&
      src.includes("gateway.json")
    );
  } catch {
    return false;
  }
}

export function liveClassify(
  identity: ProcessIdentity,
): "wrapper" | "supervisor" | "host" | "temp-supervisor" | null {
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

export function liveAdoptLaunchSpec(
  env: Record<string, string>,
  input: { execPath: string; hostBundle: string; cwd: string },
): { execPath: string; argv: string[]; cwd: string; env: Record<string, string> } {
  return {
    execPath: input.execPath,
    argv: [input.hostBundle],
    cwd: input.cwd,
    env: { ...env, GROKBOX_ALLOW_LIVE_HOST: "1" },
  };
}

export function identityHostReady(input: {
  marker: IdentityMarker | null;
  gatewayPid: number | null;
  hostPid: number;
}): boolean {
  return Boolean(
    input.marker &&
      input.marker.pid === input.hostPid &&
      input.marker.compiled === true &&
      input.gatewayPid === input.hostPid,
  );
}

export function readGatewayPid(path = LIVE_GATEWAY_JSON): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
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
      (marker.mode !== "identity" && marker.mode !== "route") ||
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
      procEnvHas(host.pid, "NODE_OPTIONS", input.preloadNeedle) || procEnvHas(host.pid, "GROKBOX_PRELOAD_MODE"),
  };
}

export function createLiveH3AdoptPorts(input: {
  markerPath: string;
  preloadNeedle: string;
  overlayPath: string;
  execPath: string;
  hostBundle?: string;
  waitMs?: number;
}): H3AdoptPorts {
  const port = linuxProcessPort();
  const waitMs = input.waitMs ?? LIVE_WAIT_MS;
  const hostBundle = input.hostBundle ?? LIVE_HOST_BUNDLE;
  return {
    target: {
      readSource: () => {
        const bytes = readFileSync(hostBundle);
        const source = bytes.toString("utf8");
        if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("unsupported-host-encoding");
        return source;
      },
      launchStrategy: (supervisor) => decideH3LaunchStrategy({
        supervisor,
        reviewedAdoptCapability: reviewOfficialAdoptCapability(supervisor),
      }),
    },
    processes: port,
    classify: liveClassify,
    waitHostGone: async (old) =>
      await waitUntil(() => {
        const observed = inspectPid(old.pid);
        return observed == null || observed.start !== old.start;
      }, waitMs),
    supervisorRelaunch: async () => null,
    waitReady: async (hostPid) => {
      const ready = await waitUntil(
        () =>
          identityHostReady({
            marker: readMarkerFile(input.markerPath),
            gatewayPid: readGatewayPid(),
            hostPid,
          }),
        waitMs,
      );
      return ready ? readMarkerFile(input.markerPath) : null;
    },
    applyLaunchEnv: async (env) => {
      const spec = liveAdoptLaunchSpec(env, {
        execPath: input.execPath,
        hostBundle,
        cwd: dirname(hostBundle),
      });
      await mkdir(dirname(input.overlayPath), { recursive: true, mode: 0o700 });
      await writeFile(input.overlayPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    },
    hasGrokboxPreload: (host) =>
      procEnvHas(host.pid, "NODE_OPTIONS", input.preloadNeedle) || procEnvHas(host.pid, "GROKBOX_PRELOAD_MODE"),
    spawnTempSupervisor: async () => {
      spawn(input.execPath, [TEMP_SUPERVISOR, input.overlayPath], { stdio: "ignore" });
      const ok = await waitUntil(
        () => port.list().some((ident) => liveClassify(ident) === "temp-supervisor"),
        waitMs,
      );
      if (!ok) return null;
      return port.list().find((ident) => liveClassify(ident) === "temp-supervisor") ?? null;
    },
    waitNewHost: async (oldHostPid) => {
      const ok = await waitUntil(() => {
        const host = port.list().find((ident) => liveClassify(ident) === "host");
        return Boolean(host && host.pid !== oldHostPid && inspectPid(host.pid));
      }, waitMs);
      if (!ok) return null;
      return port.list().find((ident) => liveClassify(ident) === "host" && ident.pid !== oldHostPid) ?? null;
    },
    readGatewayPid: () => readGatewayPid(),
    guardianDeadlineMs: waitMs,
    waitBudgetMs: waitMs,
    adoptProveMs: waitMs,
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
      if (reviewed.ok) reviewed = validateReviewedProfile(profile, readFileSync(LIVE_HOST_BUNDLE, "utf8"));
    } catch {
      reviewed = { ok: false, code: "unreviewed-profile" };
    }
  }
  const strategy = unique.ok
    ? decideH3LaunchStrategy({
        supervisor: unique.chain.supervisor,
        reviewedAdoptCapability: reviewOfficialAdoptCapability(unique.chain.supervisor),
      })
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
  const execPath = input.execPath ?? (existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath);
  const host = preflight.chain!.host;
  const supervisor = linuxProcessPort().list().find((ident) => liveClassify(ident) === "supervisor");
  const launchSource = fillMissingLaunchEnv(
    readNamedProcEnv(host.pid, IDENTITY_LAUNCH_ALLOWLIST),
    supervisor ? readNamedProcEnv(supervisor.pid, IDENTITY_LAUNCH_ALLOWLIST) : {},
  );
  if (preflight.strategy === "transient-adopt-candidate") {
    const ports = createLiveH3AdoptPorts({
      markerPath,
      preloadNeedle: input.preloadPath,
      overlayPath,
      execPath,
      hostBundle: input.hostBundle ?? LIVE_HOST_BUNDLE,
    });
    const inject = await runH3OfflineAdopt({
      ephemeralRoot,
      reviewedProfilePath: input.reviewedProfilePath,
      diskSha: liveDiskSha,
      operationId: input.operationId ?? `h3-live-adopt-${Date.now()}`,
      execPath,
      preloadPath: input.preloadPath,
      hostBundle: input.hostBundle ?? LIVE_HOST_BUNDLE,
      markerPath,
      launchSource,
      ports,
    });
    if (!inject.ok) {
      return { preflight, injected: true, inject };
    }
    const deactivate = await runH3OfflineAdoptDeactivate({
      ephemeralRoot,
      diskSha: liveDiskSha,
      ports,
    });
    return { preflight, injected: true, inject, deactivate };
  }
  const ports = createLiveH3Ports({
    markerPath,
    preloadNeedle: input.preloadPath,
    overlayPath,
  });
  const inject = await runH3OfflineInject({
    ephemeralRoot,
    reviewedProfilePath: input.reviewedProfilePath,
    diskSha: liveDiskSha,
    operationId: input.operationId ?? `h3-live-${Date.now()}`,
    execPath,
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
