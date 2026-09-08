import { existsSync } from "node:fs";
import { join } from "node:path";
import { pinLaunchProfile } from "./compile-receipt.ts";
import { type WatchdogAdoptPorts, WATCHDOG_OPERATION_ID } from "./coordinator.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { spawnIndependentGuardian } from "./guardian-process.ts";
import { identityLaunchFields } from "./h3-identity.ts";
import { createLiveH3AdoptPorts } from "./h3-live.ts";
import { sha256Text } from "./hash.ts";
import { fillMissingLaunchEnv, IDENTITY_LAUNCH_ALLOWLIST } from "./launch-env.ts";
import { LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { procEnvHas, readNamedProcEnv } from "./live-proc.ts";
import { waitOfficialReplacement, type RoleClassifier } from "./official-chain.ts";
import type { ProcessIdentity, ProcessPort } from "./process.ts";
import { loadDurableReviewedProfile } from "./reviewed-profile.ts";
import { resolvePreloadPath } from "./runtime-helpers.ts";
import type { DesiredMode } from "./models.ts";
import type { PatchProfile } from "./transform.ts";

/** Node `--require` cannot load the source `preload.ts` fallback. Prefer a built CJS in the run root. */
function nodeRequireablePreload(): string {
  const resolved = resolvePreloadPath();
  if (resolved.endsWith(".cjs") && existsSync(resolved)) return resolved;
  const runBuilt = join(ephemeralRuntimeRoot(), "preload.cjs");
  if (existsSync(runBuilt)) return runBuilt;
  return resolved;
}
const PRELOAD_PATH = nodeRequireablePreload();

export const liveH3AdoptAdapter = {
  createLiveH3AdoptPorts,
};

export type LiveManualReadoptPorts = {
  ephemeralRoot: string;
  processes: ProcessPort;
  classify: RoleClassifier;
  envHas: (pid: number, key: string) => boolean;
  freshDiskSha: () => string;
  reviewedProfile?: PatchProfile;
  adopt: WatchdogAdoptPorts;
  waitReplacement: (oldPid: number) => Promise<ProcessIdentity | null>;
};

/** Live adopt ports + durable reviewed profile. Call only after --confirm and assertBoxLocal. */
export function wireLiveManualReadopt(input: {
  root: string;
  ephemeralRoot?: string;
  now: () => number;
  mode?: DesiredMode;
}): LiveManualReadoptPorts {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const markerPath = join(ephemeralRoot, "state", "preload-marker.json");
  const overlayPath = join(ephemeralRoot, "state", "launch-env.json");
  const execPath = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
  const preloadMode = input.mode === "route" ? "route" : "identity";
  const ports = liveH3AdoptAdapter.createLiveH3AdoptPorts({
    markerPath,
    preloadNeedle: PRELOAD_PATH,
    overlayPath,
    execPath,
    hostBundle: LIVE_HOST_BUNDLE,
  });
  const reviewedProfile = loadDurableReviewedProfile(input.root);
  const adopt: WatchdogAdoptPorts = {
    target: ports.target,
    spawnTempSupervisor: ports.spawnTempSupervisor,
    waitNewHost: ports.waitNewHost,
    waitGone: ports.waitHostGone,
    waitReady: ports.waitReady,
    readGatewayPid: ports.readGatewayPid,
    hasGrokboxPreload: ports.hasGrokboxPreload,
    adoptProveMs: ports.adoptProveMs,
    prepareTempLaunch: async (profile) => {
      const profilePath = await pinLaunchProfile(ephemeralRoot, profile);
      const host = ports.processes.list().find((ident) => ports.classify(ident) === "host");
      if (!host) throw new Error("missing-host");
      const supervisor = ports.processes.list().find((ident) => ports.classify(ident) === "supervisor");
      const launched = identityLaunchFields({
        source: fillMissingLaunchEnv(
          readNamedProcEnv(host.pid, IDENTITY_LAUNCH_ALLOWLIST),
          supervisor ? readNamedProcEnv(supervisor.pid, IDENTITY_LAUNCH_ALLOWLIST) : {},
        ),
        preloadPath: PRELOAD_PATH,
        profilePath,
        markerPath,
        operationId: WATCHDOG_OPERATION_ID,
        hostBundle: LIVE_HOST_BUNDLE,
        mode: preloadMode,
        durableRoot: input.root,
        runRoot: ephemeralRoot,
      });
      if (!launched.ok) throw new Error(launched.code);
      await ports.applyLaunchEnv(launched.env);
    },
    armGuardian: async (frozen) => {
      const guardian = await spawnIndependentGuardian({
        frozen,
        deadlineMs: ports.guardianDeadlineMs ?? 8000,
        stateDir: ephemeralRoot,
        execPath,
      });
      if (!guardian.armed) return { ok: false };
      return { ok: true, release: guardian.release };
    },
  };
  return {
    ephemeralRoot,
    processes: ports.processes,
    classify: ports.classify,
    envHas: (pid, key) => procEnvHas(pid, key),
    freshDiskSha: () => {
      try {
        return ports.target ? sha256Text(ports.target.readSource()) : "none";
      } catch {
        return "none";
      }
    },
    ...(reviewedProfile ? { reviewedProfile } : {}),
    adopt,
    waitReplacement: async (oldPid) =>
      await waitOfficialReplacement({
        oldPid,
        processes: ports.processes,
        classify: ports.classify,
        hasGrokboxPreload: (host) => ports.hasGrokboxPreload(host),
        readGatewayPid: () => ports.readGatewayPid(),
        budgetMs: ports.waitBudgetMs ?? 8000,
      }),
  };
}
