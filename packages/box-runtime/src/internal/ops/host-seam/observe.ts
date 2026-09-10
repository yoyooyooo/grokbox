import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../../host/live-slices.ts";
import type { PatchProfile } from "../../host/profile.ts";
import { HOST_BUNDLE_KEEP, retainHostBundle } from "../../io/provenance.node.ts";
import { observeKnifePoints, type KnifePointObservation } from "./knife-points.ts";
import { buildRetentionPlan, type RetentionPlan } from "./prune.ts";

const SOURCE_MAX_BYTES = 64 * 1024 * 1024;

export type HostSeamObserveReceipt = {
  observedSha: string;
  bytes: number;
  retained: "new" | "existing";
  entryIntegrity: "ok";
  installationConsistency: "unknown";
  knifePoints: KnifePointObservation["rows"];
  applyCode: KnifePointObservation["applyCode"];
  keep: typeof HOST_BUNDLE_KEEP;
  protectedShas: string[];
  retentionPressure: boolean;
  retentionPlan: RetentionPlan;
  signaled: false;
  adopted: false;
  gaps: string[];
};

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

export async function observeHostProvenance(input: {
  root: string;
  from: string;
  now?: () => string;
  profile?: PatchProfile;
}): Promise<HostSeamObserveReceipt> {
  if (typeof input.from !== "string" || !isAbsolute(input.from)) invalid("--from must be an absolute Host path.");
  const from = resolve(input.from);
  let info;
  try {
    info = await lstat(from);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      invalid("Host bundle input is unavailable.");
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) invalid("Host bundle input must be a regular non-symlink file.");
  if (info.nlink > 1) invalid("Host bundle input must not be a hardlink alias.");
  if (info.size > SOURCE_MAX_BYTES) invalid("Host bundle exceeds the observe size budget.");

  const handle = await open(from, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
      invalid("Host bundle changed during observe.");
    }
  } finally {
    await handle.close();
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new BoxRuntimeError("invalid_usage", "Host bundle must be valid UTF-8.");
  }
  const observedSha = sha256Bytes(bytes);
  if (observedSha !== sha256Text(source)) invalid("source_changed");

  const profile = input.profile ?? {
    profileId: "hso-observe-recipe",
    sourceSha256: observedSha,
    transformedSourceSha256: "0".repeat(64),
    slices: LIVE_SLICE_PATCHES.filter((slice) => slice.id === "create-session" || slice.id === "agent-id"),
  };
  const knife = observeKnifePoints(source, profile);
  const at = input.now?.() ?? new Date().toISOString();
  const retainInput = {
    root: input.root,
    source,
    sourceSha: observedSha,
    observedAt: at,
    ...(profile.profileId !== "hso-observe-recipe" && profile.sourceSha256 === observedSha
      ? { matchedProfileId: profile.profileId }
      : {}),
  };
  let retained;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      retained = await retainHostBundle(retainInput);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "retain_failed";
      const retryable = message.includes("bytes-mismatch") && attempt < 7;
      if (!retryable) {
        if (message.includes("bytes-mismatch") || message.includes("sha-mismatch")) invalid("corpus_corrupt");
        invalid(message);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!retained) invalid("corpus_corrupt");
  const retentionPlan = await buildRetentionPlan(input.root, observedSha);

  return {
    observedSha,
    bytes: bytes.length,
    retained: retained.retained,
    entryIntegrity: "ok",
    installationConsistency: "unknown",
    knifePoints: knife.rows,
    applyCode: knife.applyCode,
    keep: HOST_BUNDLE_KEEP,
    protectedShas: retentionPlan.protectedShas,
    retentionPressure: retentionPlan.retentionPressure,
    retentionPlan,
    signaled: false,
    adopted: false,
    gaps: knife.traceMismatch ? ["trace_mismatch"] : [],
  };
}
