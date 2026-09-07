import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeRuntimeArtifact } from "./runtime-artifact.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import type { ProcessIdentity } from "./process.ts";
import type { PatchProfile } from "./transform.ts";
import { boundedText, count, isRecord, observeJson } from "./observation.ts";

type CoverageAttestationBase = {
  coverage: "attested";
  diskSha: string;
  pid: number;
  start: number;
  identity: ProcessIdentity;
  at: string;
  windowMs?: number;
  launchMode?: "direct-launch" | "transient-adopt";
  operationId?: string;
  compile?: CompileReceipt;
};

export type IdentityAttestation = CoverageAttestationBase & {
  mode: "identity";
  modeld: false;
  profileId?: string;
  transformedSha?: string;
};

export type RouteAttestation = CoverageAttestationBase & {
  mode: "route";
  modeld: true;
  profileId: string;
  transformedSha: string;
};

export type CoverageAttestation = IdentityAttestation | RouteAttestation;

export type RouteProfileIdentity = Pick<
  PatchProfile,
  "profileId" | "sourceSha256" | "transformedSourceSha256"
>;

export function routeAttestationAgrees(
  att: CoverageAttestation | null | undefined,
  reviewed: RouteProfileIdentity | undefined,
): boolean {
  if (!att || att.mode !== "route") return false;
  if (!reviewed) return false;
  if (att.modeld !== true) return false;
  if (typeof att.profileId !== "string" || att.profileId.length === 0) return false;
  if (typeof att.transformedSha !== "string" || att.transformedSha.length === 0) return false;
  if (att.diskSha !== reviewed.sourceSha256) return false;
  if (att.profileId !== reviewed.profileId) return false;
  if (att.transformedSha !== reviewed.transformedSourceSha256) return false;
  return true;
}

export function attestationPath(ephemeralRoot = ephemeralRuntimeRoot()): string {
  return join(ephemeralRoot, "attestation.json");
}

export function parseAttestation(value: unknown): CoverageAttestation {
  if (!isRecord(value) || !isRecord(value.identity)) throw new Error("invalid attestation");
  const identity = value.identity;
  if (value.coverage !== "attested" || !boundedText(value.diskSha, 128) || !count(value.pid) || value.pid === 0 ||
    !count(value.start) || value.pid !== identity.pid || value.start !== identity.start ||
    !boundedText(value.at) || !Number.isFinite(Date.parse(value.at)) ||
    !count(identity.uid) || !count(identity.ppid) || !boundedText(identity.exe, 4096) ||
    !Array.isArray(identity.cmdline) || identity.cmdline.length > 64 || !identity.cmdline.every((arg) => typeof arg === "string" && arg.length <= 4096) ||
    !Array.isArray(identity.ancestry) || identity.ancestry.length > 128 || !identity.ancestry.every(count) ||
    (value.windowMs !== undefined && (typeof value.windowMs !== "number" || !Number.isFinite(value.windowMs) || value.windowMs < 0)) ||
    (value.launchMode !== undefined && value.launchMode !== "direct-launch" && value.launchMode !== "transient-adopt") ||
    (value.mode !== "identity" && value.mode !== "route") || value.modeld !== (value.mode === "route")) {
    throw new Error("invalid attestation");
  }
  if ((value.profileId !== undefined && !boundedText(value.profileId, 128)) ||
    (value.transformedSha !== undefined && !boundedText(value.transformedSha, 128))) throw new Error("invalid attestation profile");
  if (value.compile !== undefined) {
    const c = value.compile;
    if (!isRecord(c) || !boundedText(c.profileId, 128) || !boundedText(c.profileSha256, 128) || !boundedText(c.transformedSha256, 128) ||
      c.sourceSha256 !== value.diskSha || c.profileId !== value.profileId || c.transformedSha256 !== value.transformedSha ||
      !boundedText(value.operationId)) throw new Error("invalid compile receipt");
  }
  return value as CoverageAttestation;
}

/** Observation preserves missing/bad distinctions without treating them as a new authorization. */
export function observeAttestation(root = ephemeralRuntimeRoot()) {
  return observeJson(attestationPath(root), parseAttestation);
}

export async function readAttestation(root = ephemeralRuntimeRoot()): Promise<CoverageAttestation | null> {
  try {
    return JSON.parse(await readFile(attestationPath(root), "utf8")) as CoverageAttestation;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAttestation(root: string, value: CoverageAttestation): Promise<void> {
  await writeRuntimeArtifact(attestationPath(root), value);
}

export async function clearAttestation(root = ephemeralRuntimeRoot()): Promise<void> {
  try {
    await unlink(attestationPath(root));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
