import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeRuntimeArtifact } from "./runtime-artifact.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import type { ProcessIdentity } from "./process.ts";
import type { PatchProfile } from "./transform.ts";

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
