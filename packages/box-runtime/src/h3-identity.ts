import { readFileSync } from "node:fs";
import { spawnIndependentGuardian } from "./guardian-process.ts";
import { runIdentityDeactivate, runIdentityOperation, type IdentityOpResult } from "./identity-op.ts";
import { pickLaunchEnv } from "./launch-env.ts";
import { loadReviewedProfile, type RoleClassifier } from "./official-chain.ts";
import type { ProcessIdentity, ProcessPort } from "./process.ts";
import type { PatchProfile } from "./transform.ts";

export type H3OfflinePorts = {
  processes: ProcessPort;
  classify: RoleClassifier;
  waitHostGone: (old: ProcessIdentity) => Promise<boolean>;
  supervisorRelaunch: (supervisor: ProcessIdentity) => Promise<ProcessIdentity | null>;
  waitReady: (hostPid: number) => Promise<import("./identity-op.ts").IdentityMarker | null>;
  prepareReplacement?: () => Promise<void>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  persistAttestation?: (host: ProcessIdentity, sha: string, windowMs: number) => Promise<void>;
  clearAttestation: () => Promise<void>;
  now?: () => number;
};

function loadExistingReviewedProfile(path: string, observedSha: string): PatchProfile {
  const profile = JSON.parse(readFileSync(path, "utf8")) as PatchProfile;
  const checked = loadReviewedProfile(profile, observedSha);
  if (!checked.ok) {
    throw new Error(checked.code);
  }
  return profile;
}

/** Non-public H3 composition. Does not target the live Host. */
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
  observedSha: string;
  operationId: string;
  execPath: string;
  ports: H3OfflinePorts;
}): Promise<IdentityOpResult> {
  let profile: PatchProfile;
  try {
    profile = loadExistingReviewedProfile(input.reviewedProfilePath, input.observedSha);
  } catch {
    return {
      ok: false,
      recoveryRequired: false,
      code: "unknown-sha",
      signaled: false,
      diskShaBefore: input.observedSha,
      diskShaAfter: input.observedSha,
      census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
      coverage: "none",
    };
  }
  return await runIdentityOperation({
    processes: input.ports.processes,
    classify: input.ports.classify,
    reviewedProfile: profile,
    diskSha: () => input.observedSha,
    ephemeralRoot: input.ephemeralRoot,
    operationId: input.operationId,
    readMarker: () => null,
    waitHostGone: input.ports.waitHostGone,
    supervisorRelaunch: input.ports.supervisorRelaunch,
    waitReady: input.ports.waitReady,
    prepareReplacement: input.ports.prepareReplacement,
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
    persistAttestation: input.ports.persistAttestation,
    now: input.ports.now ?? (() => Date.now()),
  });
}

export async function runH3OfflineDeactivate(input: {
  ephemeralRoot: string;
  observedSha: string;
  ports: H3OfflinePorts;
  attestation: { identity: ProcessIdentity; diskSha: string } | null;
}): Promise<IdentityOpResult> {
  return await runIdentityDeactivate({
    processes: input.ports.processes,
    classify: input.ports.classify,
    diskSha: () => input.observedSha,
    ephemeralRoot: input.ephemeralRoot,
    attestation: input.attestation,
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
    clearAttestation: input.ports.clearAttestation,
  });
}
