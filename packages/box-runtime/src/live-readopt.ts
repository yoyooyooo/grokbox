import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAttestation } from "./attestation.ts";
import { type WatchdogAdoptPorts, WATCHDOG_OPERATION_ID } from "./coordinator.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { spawnIndependentGuardian } from "./guardian-process.ts";
import { identityLaunchFields } from "./h3-identity.ts";
import { createLiveH3AdoptPorts, liveDiskSha } from "./h3-live.ts";
import { IDENTITY_LAUNCH_ALLOWLIST } from "./launch-env.ts";
import { LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { procEnvHas, readNamedProcEnv } from "./live-proc.ts";
import { findUniqueOfficialChain, type RoleClassifier } from "./official-chain.ts";
import { reviewedProfilePath } from "./paths.ts";
import type { ProcessIdentity, ProcessPort } from "./process.ts";
import type { PatchProfile } from "./transform.ts";

const PRELOAD_PATH = fileURLToPath(new URL("./preload.ts", import.meta.url));

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

function loadDurableReviewedProfile(root: string): PatchProfile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(reviewedProfilePath(root), "utf8")) as PatchProfile;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function safeLiveDiskSha(): string {
  try {
    return liveDiskSha();
  } catch {
    return "none";
  }
}

/** Live adopt ports + durable reviewed profile. Call only after --confirm and assertBoxLocal. */
export function wireLiveManualReadopt(input: {
  root: string;
  ephemeralRoot?: string;
  now: () => number;
}): LiveManualReadoptPorts {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const markerPath = join(ephemeralRoot, "state", "preload-marker.json");
  const overlayPath = join(ephemeralRoot, "state", "launch-env.json");
  const profilePath = reviewedProfilePath(input.root);
  const execPath = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
  const ports = liveH3AdoptAdapter.createLiveH3AdoptPorts({
    markerPath,
    preloadNeedle: PRELOAD_PATH,
    overlayPath,
    execPath,
    hostBundle: LIVE_HOST_BUNDLE,
  });
  const reviewedProfile = loadDurableReviewedProfile(input.root);
  const adopt: WatchdogAdoptPorts = {
    spawnTempSupervisor: ports.spawnTempSupervisor,
    waitNewHost: ports.waitNewHost,
    waitGone: ports.waitHostGone,
    waitReady: ports.waitReady,
    readGatewayPid: ports.readGatewayPid,
    hasGrokboxPreload: ports.hasGrokboxPreload,
    adoptProveMs: ports.adoptProveMs,
    prepareTempLaunch: async () => {
      const host = ports.processes.list().find((ident) => ports.classify(ident) === "host");
      if (!host) throw new Error("missing-host");
      const launched = identityLaunchFields({
        source: readNamedProcEnv(host.pid, IDENTITY_LAUNCH_ALLOWLIST),
        preloadPath: PRELOAD_PATH,
        profilePath,
        markerPath,
        operationId: WATCHDOG_OPERATION_ID,
        hostBundle: LIVE_HOST_BUNDLE,
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
    persistAttestation: async (host, nextSha, windowMs) => {
      await writeAttestation(ephemeralRoot, {
        mode: "identity",
        coverage: "attested",
        diskSha: nextSha,
        pid: host.pid,
        start: host.start,
        identity: host,
        at: new Date(input.now()).toISOString(),
        modeld: false,
        windowMs,
        launchMode: "transient-adopt",
      });
    },
  };
  return {
    ephemeralRoot,
    processes: ports.processes,
    classify: ports.classify,
    envHas: (pid, key) => procEnvHas(pid, key),
    freshDiskSha: safeLiveDiskSha,
    ...(reviewedProfile ? { reviewedProfile } : {}),
    adopt,
    waitReplacement: async (oldPid) => {
      const started = Date.now();
      const budget = ports.waitBudgetMs ?? 8000;
      while (Date.now() - started < budget) {
        const unique = findUniqueOfficialChain(ports.processes, ports.classify);
        if (
          unique.ok &&
          unique.chain.host.pid !== oldPid &&
          !ports.hasGrokboxPreload(unique.chain.host)
        ) {
          return unique.chain.host;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
  };
}
