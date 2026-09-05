import { appendEvent, compactEvents } from "./events.ts";
import { hashSource, pruneGenerations, readGeneration, readHead, snapshotContracts } from "./contracts.ts";
import { signalIfMatch, type ProcessIdentity, type ProcessPort } from "./process.ts";

export type AttestationRecord = {
  pid: number;
  start: number;
  sourceSha: string;
  identity: ProcessIdentity;
};

export type ObserveDisk = {
  source: string;
  sha?: string;
};

export type ObserveResult = {
  coverage: "none" | "window-open" | "attested";
  reason?: "unsupported_bundle";
  watchdogState: "running" | "degraded";
  diskSha: string;
  driftedSlices: string[];
  injected: false;
  lastHeal: { outcome: "exited" | "supervisor_relaunched" | "failed" | "skipped" } | null;
  circuit: "closed" | "open";
};

export async function observeAndHeal(input: {
  root: string;
  disk: ObserveDisk;
  processes: ProcessPort;
  host: ProcessIdentity | null;
  attestation: AttestationRecord | null;
  now: () => string;
  matchedProfileId?: string;
  relaunchUnpatched?: (sha: string) => void;
}): Promise<{ result: ObserveResult; attestation: AttestationRecord | null }> {
  const sha = input.disk.sha ?? hashSource(input.disk.source);
  const at = input.now();
  await appendEvent(input.root, { name: "disk_sha_observed", at, sha });

  const head = await readHead(input.root);
  let driftedSlices: string[] = [];
  if (head !== sha) {
    const previous = head ? await readGeneration(input.root, head) : null;
    const generation = await snapshotContracts({
      root: input.root,
      source: input.disk.source,
      sourceSha: sha,
      observedAt: at,
      previous,
      matchedProfileId: input.matchedProfileId,
    });
    driftedSlices = generation.driftedSlices;
    await appendEvent(input.root, {
      name: "contracts_snapshot",
      at,
      sha,
      driftedSlices,
    });
    await pruneGenerations({
      root: input.root,
      liveSha: sha,
      lastMatchedSha: input.matchedProfileId ? sha : previous?.matchedProfileId ? previous.sourceSha : null,
    });
  }

  let attestation = input.attestation;
  let lastHeal: ObserveResult["lastHeal"] = null;
  let circuit: ObserveResult["circuit"] = "closed";
  let coverage: ObserveResult["coverage"] = input.matchedProfileId && attestation?.sourceSha === sha
    ? "attested"
    : "none";
  let watchdogState: ObserveResult["watchdogState"] = "running";
  let reason: ObserveResult["reason"];

  if (attestation && attestation.sourceSha !== sha) {
    await appendEvent(input.root, {
      name: "attestation_invalidated",
      at,
      reason: "disk_sha_changed",
      oldSha: attestation.sourceSha,
      sha,
    });
    coverage = "window-open";
    reason = "unsupported_bundle";
    circuit = "open";
    watchdogState = "degraded";
    await appendEvent(input.root, { name: "circuit_open", at, reason: "unsupported_bundle", sha });

    const live = input.host && input.processes.inspect(input.host.pid);
    const stale = live && live.pid === attestation.pid && live.start === attestation.start;
    if (stale && input.host) {
      await appendEvent(input.root, {
        name: "stale_patched_detected",
        at,
        oldSha: attestation.sourceSha,
        newDiskSha: sha,
        pid: attestation.pid,
        start: attestation.start,
      });
      const term = signalIfMatch(input.processes, attestation.identity, "SIGTERM");
      if (term.ok) {
        input.relaunchUnpatched?.(sha);
        lastHeal = { outcome: "supervisor_relaunched" };
        await appendEvent(input.root, { name: "stale_patched_term", at, outcome: "supervisor_relaunched" });
      } else {
        lastHeal = { outcome: "failed" };
        await appendEvent(input.root, { name: "stale_patched_term", at, outcome: "failed" });
      }
    } else {
      lastHeal = { outcome: "skipped" };
    }
    attestation = null;
  }

  await compactEvents(input.root);

  return {
    attestation,
    result: {
      coverage,
      reason,
      watchdogState,
      diskSha: sha,
      driftedSlices,
      injected: false,
      lastHeal,
      circuit,
    },
  };
}
