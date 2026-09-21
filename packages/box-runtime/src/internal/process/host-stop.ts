import { existsSync } from "node:fs";
import { join } from "node:path";
import { clearAttestation, readAttestation, type CoverageAttestation } from "../io/authority.node.ts";
import { ephemeralRuntimeRoot } from "../io/ephemeral.ts";
import { LIVE_HOST_BUNDLE } from "../host/live-slices.ts";
import { createLiveH3AdoptPorts, liveDiskSha } from "./h3-live.ts";
import { resolveNodeRequireablePreload } from "./helpers/runtime-helpers.ts";
import { runIdentityDeactivate, type IdentityOpResult } from "./identity-op.ts";
import { waitOfficialReplacement, type RoleClassifier } from "./official-chain.ts";
import { countRoles, type ProcessIdentity, type ProcessPort } from "./process-port.ts";
import { runTransientAdoptDeactivate } from "./transient-adopt.ts";

export type StopPatchedHostInput = {
  processes: ProcessPort;
  classify: RoleClassifier;
  diskSha: () => string;
  ephemeralRoot: string;
  waitGone: (old: ProcessIdentity) => Promise<boolean>;
  waitReplacement: (oldPid: number) => Promise<ProcessIdentity | null>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  readGatewayPid: () => number | null;
  readAttestationRecord: () => Promise<CoverageAttestation | null>;
  clearAttestation: () => Promise<void>;
};

function censusOf(processes: ProcessPort, classify: RoleClassifier) {
  return countRoles(
    processes.list().flatMap((ident) => {
      const role = classify(ident);
      return role ? [{ ...ident, role }] : [];
    }),
  );
}

function uniqueHost(processes: ProcessPort, classify: RoleClassifier): ProcessIdentity | null {
  const hosts = processes.list().filter((ident) => classify(ident) === "host");
  return hosts.length === 1 ? hosts[0]! : null;
}

function result(
  input: StopPatchedHostInput,
  extras: Partial<IdentityOpResult> & Pick<IdentityOpResult, "ok" | "signaled" | "coverage">,
): IdentityOpResult {
  const sha = input.diskSha();
  return {
    recoveryRequired: extras.ok !== true,
    diskShaBefore: sha,
    diskShaAfter: sha,
    census: censusOf(input.processes, input.classify),
    ...extras,
  };
}

function usesTransientDeactivate(attestation: CoverageAttestation): boolean {
  return attestation.mode === "route" || attestation.launchMode === "transient-adopt";
}

/**
 * Unload a grokbox-patched Host toward a unique unpatched official chain.
 * Desired-file writes stay with the CLI composition root; this only proves process/attestation coverage.
 */
export async function stopPatchedHostCoverage(input: StopPatchedHostInput): Promise<IdentityOpResult> {
  const hosts = input.processes.list().filter((ident) => input.classify(ident) === "host");
  if (hosts.length > 1) {
    return result(input, { ok: false, signaled: false, coverage: "window-open", code: "duplicate-role" });
  }
  const host = uniqueHost(input.processes, input.classify);
  const patched = host ? input.hasGrokboxPreload(host) : false;
  const attestation = await input.readAttestationRecord();

  if (!attestation && !patched) {
    return result(input, {
      ok: true,
      recoveryRequired: false,
      signaled: false,
      coverage: "none",
      ...(host ? { host } : {}),
    });
  }
  if (!attestation) {
    return result(input, { ok: false, signaled: false, coverage: "window-open", code: "no-attestation" });
  }

  const shared = {
    processes: input.processes,
    classify: input.classify,
    diskSha: input.diskSha,
    ephemeralRoot: input.ephemeralRoot,
    attestation: { identity: attestation.identity, diskSha: attestation.diskSha },
    hasGrokboxPreload: input.hasGrokboxPreload,
    clearAttestation: input.clearAttestation,
  };
  if (usesTransientDeactivate(attestation)) {
    return await runTransientAdoptDeactivate({
      ...shared,
      waitGone: input.waitGone,
      waitReplacement: input.waitReplacement,
      readGatewayPid: input.readGatewayPid,
    });
  }
  return await runIdentityDeactivate({
    ...shared,
    waitHostGone: input.waitGone,
    waitReplacement: input.waitReplacement,
  });
}

export async function stopLivePatchedHost(input: { ephemeralRoot?: string } = {}): Promise<IdentityOpResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const markerPath = join(ephemeralRoot, "state", "preload-marker.json");
  const overlayPath = join(ephemeralRoot, "state", "launch-env.json");
  const execPath = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
  const preloadPath = resolveNodeRequireablePreload();
  const ports = createLiveH3AdoptPorts({
    markerPath,
    preloadNeedle: preloadPath,
    overlayPath,
    execPath,
    hostBundle: LIVE_HOST_BUNDLE,
  });
  return await stopPatchedHostCoverage({
    processes: ports.processes,
    classify: ports.classify,
    diskSha: liveDiskSha,
    ephemeralRoot,
    waitGone: ports.waitHostGone,
    waitReplacement: async (oldPid) =>
      await waitOfficialReplacement({
        oldPid,
        processes: ports.processes,
        classify: ports.classify,
        hasGrokboxPreload: (host) => ports.hasGrokboxPreload(host),
        readGatewayPid: () => ports.readGatewayPid(),
        budgetMs: ports.waitBudgetMs ?? 8000,
      }),
    hasGrokboxPreload: ports.hasGrokboxPreload,
    readGatewayPid: () => ports.readGatewayPid(),
    readAttestationRecord: () => readAttestation(ephemeralRoot),
    clearAttestation: () => clearAttestation(ephemeralRoot),
  });
}
