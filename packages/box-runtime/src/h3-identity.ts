import { readFileSync } from "node:fs";
import { readAttestation, writeAttestation, clearAttestation } from "./attestation.ts";
import { spawnIndependentGuardian } from "./guardian-process.ts";
import {
  attestationAgrees,
  runIdentityDeactivate,
  runIdentityOperation,
  type IdentityOpResult,
} from "./identity-op.ts";
import { pickLaunchEnv } from "./launch-env.ts";
import { findUniqueOfficialChain, loadReviewedProfile, type RoleClassifier } from "./official-chain.ts";
import type { ProcessIdentity, ProcessPort } from "./process.ts";
import {
  runTransientAdoptDeactivate,
  runTransientAdoptOperation,
} from "./transient-adopt.ts";
import type { PatchProfile } from "./transform.ts";

export type H3OfflinePorts = {
  processes: ProcessPort;
  classify: RoleClassifier;
  waitHostGone: (old: ProcessIdentity) => Promise<boolean>;
  supervisorRelaunch: (supervisor: ProcessIdentity) => Promise<ProcessIdentity | null>;
  waitReady: (hostPid: number) => Promise<import("./identity-op.ts").IdentityMarker | null>;
  applyLaunchEnv: (env: Record<string, string>) => Promise<void>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  now?: () => number;
};

export type H3AdoptPorts = H3OfflinePorts & {
  spawnTempSupervisor: () => Promise<ProcessIdentity | null>;
  waitNewHost: (oldHostPid: number) => Promise<ProcessIdentity | null>;
  readGatewayPid: () => number | null;
  guardianDeadlineMs?: number;
  waitBudgetMs?: number;
  adoptProveMs?: number;
};

function loadExistingReviewedProfile(path: string, observedSha: string): PatchProfile {
  const profile = JSON.parse(readFileSync(path, "utf8")) as PatchProfile;
  const checked = loadReviewedProfile(profile, observedSha);
  if (!checked.ok) {
    throw new Error(checked.code);
  }
  return profile;
}

/** Non-public H3 launch-env builder. Allowlist fields only. */
export function identityLaunchFields(input: {
  source: NodeJS.Dict<string>;
  preloadPath: string;
  profilePath: string;
  markerPath: string;
  operationId: string;
  hostBundle: string;
}): { ok: true; env: Record<string, string> } | { ok: false; code: "forbidden-env" } {
  const picked = pickLaunchEnv(input.source);
  if (!picked.ok) return picked;
  return {
    ok: true,
    env: {
      ...picked.env,
      NODE_OPTIONS: `--require=${input.preloadPath}`,
      GROKBOX_HOST_BUNDLE: input.hostBundle,
      GROKBOX_PATCH_PROFILE: input.profilePath,
      GROKBOX_PRELOAD_MARKER: input.markerPath,
      GROKBOX_PRELOAD_MODE: "identity",
      GROKBOX_OPERATION_ID: input.operationId,
    },
  };
}

export async function runH3OfflineInject(input: {
  ephemeralRoot: string;
  reviewedProfilePath: string;
  diskSha: () => string;
  operationId: string;
  execPath: string;
  preloadPath: string;
  hostBundle: string;
  markerPath: string;
  launchSource: NodeJS.Dict<string>;
  ports: H3OfflinePorts;
}): Promise<IdentityOpResult> {
  const observedSha = input.diskSha();
  let profile: PatchProfile;
  try {
    profile = loadExistingReviewedProfile(input.reviewedProfilePath, observedSha);
  } catch {
    return {
      ok: false,
      recoveryRequired: false,
      code: "unknown-sha",
      signaled: false,
      diskShaBefore: observedSha,
      diskShaAfter: input.diskSha(),
      census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
      coverage: "none",
    };
  }
  const result = await runIdentityOperation({
    processes: input.ports.processes,
    classify: input.ports.classify,
    reviewedProfile: profile,
    diskSha: input.diskSha,
    ephemeralRoot: input.ephemeralRoot,
    operationId: input.operationId,
    readMarker: () => null,
    waitHostGone: input.ports.waitHostGone,
    supervisorRelaunch: input.ports.supervisorRelaunch,
    waitReady: input.ports.waitReady,
    prepareReplacement: async () => {
      const launched = identityLaunchFields({
        source: input.launchSource,
        preloadPath: input.preloadPath,
        profilePath: input.reviewedProfilePath,
        markerPath: input.markerPath,
        operationId: input.operationId,
        hostBundle: input.hostBundle,
      });
      if (!launched.ok) throw new Error(launched.code);
      await input.ports.applyLaunchEnv(launched.env);
    },
    armGuardian: async (frozen) => {
      const guardian = await spawnIndependentGuardian({
        frozen,
        deadlineMs: 8000,
        stateDir: input.ephemeralRoot,
        execPath: input.execPath,
      });
      if (!guardian.armed) return { ok: false };
      return { ok: true, release: guardian.release };
    },
    persistAttestation: async (host, sha, windowMs) => {
      await writeAttestation(input.ephemeralRoot, {
        mode: "identity",
        coverage: "attested",
        diskSha: sha,
        pid: host.pid,
        start: host.start,
        identity: host,
        at: new Date().toISOString(),
        modeld: false,
        windowMs,
        launchMode: "direct-launch",
      });
    },
    now: input.ports.now ?? (() => Date.now()),
  });
  if (!result.ok || !result.host) return result;
  const record = await readAttestation(input.ephemeralRoot);
  if (
    !record ||
    !attestationAgrees({
      attestation: record,
      liveHost: result.host,
      diskSha: result.diskShaAfter,
      census: result.census,
    })
  ) {
    return {
      ...result,
      ok: false,
      recoveryRequired: true,
      code: "attestation-uncommitted",
      coverage: "window-open",
    };
  }
  return result;
}

export async function runH3OfflineDeactivate(input: {
  ephemeralRoot: string;
  diskSha: () => string;
  ports: H3OfflinePorts;
}): Promise<IdentityOpResult> {
  const record = await readAttestation(input.ephemeralRoot);
  const result = await runIdentityDeactivate({
    processes: input.ports.processes,
    classify: input.ports.classify,
    diskSha: input.diskSha,
    ephemeralRoot: input.ephemeralRoot,
    attestation: record,
    waitHostGone: input.ports.waitHostGone,
    waitReplacement: async (oldPid) => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const host = input.ports.processes.list().find((ident) => input.ports.classify(ident) === "host");
        if (host && host.pid !== oldPid && !input.ports.hasGrokboxPreload(host)) return host;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    hasGrokboxPreload: input.ports.hasGrokboxPreload,
    clearAttestation: async () => {
      await clearAttestation(input.ephemeralRoot);
    },
  });
  return result;
}

/** Non-public transient-adopt composition. */
export async function runH3OfflineAdopt(input: {
  ephemeralRoot: string;
  reviewedProfilePath: string;
  diskSha: () => string;
  operationId: string;
  execPath: string;
  preloadPath: string;
  hostBundle: string;
  markerPath: string;
  launchSource: NodeJS.Dict<string>;
  ports: H3AdoptPorts;
}): Promise<IdentityOpResult> {
  const observedSha = input.diskSha();
  let profile: PatchProfile;
  try {
    profile = loadExistingReviewedProfile(input.reviewedProfilePath, observedSha);
  } catch {
    return {
      ok: false,
      recoveryRequired: false,
      code: "unknown-sha",
      signaled: false,
      diskShaBefore: observedSha,
      diskShaAfter: input.diskSha(),
      census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
      coverage: "none",
      launchMode: "transient-adopt",
    };
  }
  const result = await runTransientAdoptOperation({
    processes: input.ports.processes,
    classify: input.ports.classify,
    reviewedProfile: profile,
    diskSha: input.diskSha,
    ephemeralRoot: input.ephemeralRoot,
    operationId: input.operationId,
    readMarker: () => null,
    waitGone: input.ports.waitHostGone,
    waitReady: input.ports.waitReady,
    prepareTempLaunch: async () => {
      const launched = identityLaunchFields({
        source: input.launchSource,
        preloadPath: input.preloadPath,
        profilePath: input.reviewedProfilePath,
        markerPath: input.markerPath,
        operationId: input.operationId,
        hostBundle: input.hostBundle,
      });
      if (!launched.ok) throw new Error(launched.code);
      await input.ports.applyLaunchEnv(launched.env);
    },
    spawnTempSupervisor: input.ports.spawnTempSupervisor,
    waitNewHost: input.ports.waitNewHost,
    readGatewayPid: input.ports.readGatewayPid,
    adoptProveMs: input.ports.adoptProveMs,
    armGuardian: async (frozen) => {
      const guardian = await spawnIndependentGuardian({
        frozen,
        deadlineMs: input.ports.guardianDeadlineMs ?? 8000,
        stateDir: input.ephemeralRoot,
        execPath: input.execPath,
      });
      if (!guardian.armed) return { ok: false };
      return { ok: true, release: guardian.release };
    },
    persistAttestation: async (host, sha, windowMs) => {
      await writeAttestation(input.ephemeralRoot, {
        mode: "identity",
        coverage: "attested",
        diskSha: sha,
        pid: host.pid,
        start: host.start,
        identity: host,
        at: new Date().toISOString(),
        modeld: false,
        windowMs,
        launchMode: "transient-adopt",
      });
    },
    hasGrokboxPreload: input.ports.hasGrokboxPreload,
    now: input.ports.now ?? (() => Date.now()),
  });
  if (!result.ok || !result.host) return result;
  const record = await readAttestation(input.ephemeralRoot);
  if (
    !record ||
    record.launchMode !== "transient-adopt" ||
    !attestationAgrees({
      attestation: record,
      liveHost: result.host,
      diskSha: result.diskShaAfter,
      census: result.census,
    })
  ) {
    return {
      ...result,
      ok: false,
      recoveryRequired: true,
      code: "attestation-uncommitted",
      coverage: "window-open",
    };
  }
  return result;
}

export async function runH3OfflineAdoptDeactivate(input: {
  ephemeralRoot: string;
  diskSha: () => string;
  ports: H3AdoptPorts;
}): Promise<IdentityOpResult> {
  const record = await readAttestation(input.ephemeralRoot);
  return await runTransientAdoptDeactivate({
    processes: input.ports.processes,
    classify: input.ports.classify,
    diskSha: input.diskSha,
    ephemeralRoot: input.ephemeralRoot,
    attestation: record,
    waitGone: input.ports.waitHostGone,
    waitReplacement: async (oldPid) => {
      const start = Date.now();
      const budget = input.ports.waitBudgetMs ?? 8000;
      while (Date.now() - start < budget) {
        const unique = findUniqueOfficialChain(input.ports.processes, input.ports.classify);
        if (
          unique.ok &&
          unique.chain.host.pid !== oldPid &&
          !input.ports.hasGrokboxPreload(unique.chain.host)
        ) {
          return unique.chain.host;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    hasGrokboxPreload: input.ports.hasGrokboxPreload,
    readGatewayPid: input.ports.readGatewayPid,
    clearAttestation: async () => {
      await clearAttestation(input.ephemeralRoot);
    },
  });
}
