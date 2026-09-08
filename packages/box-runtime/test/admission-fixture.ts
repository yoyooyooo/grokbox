import { sha256Text } from "@grokbox/runtime-kernel/hash";
import type { AdoptTargetPorts } from "../src/internal/process/transient-adopt.ts";
import { profileFromSource, type PatchProfile } from "../src/internal/host/profile.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

export const SOURCE = SYNTHETIC_HOST;
export const NEW_SOURCE = `${SOURCE}\n// synthetic next disk generation\n`;
export const SHA = sha256Text(SOURCE);
export const NEW_SHA = sha256Text(NEW_SOURCE);
export const reviewed = profileFromSource(SOURCE, SYNTHETIC_SLICES, "reviewed");
export const nextProfile = profileFromSource(SOURCE, SYNTHETIC_SLICES.map((slice) => ({
  ...slice, replacement: `${slice.replacement}// synthetic profile refresh\n`,
})), "reviewed-next");

export function reviewedFor(sha: string): PatchProfile {
  const source = sha === NEW_SHA ? NEW_SOURCE : SOURCE;
  return { ...profileFromSource(source, SYNTHETIC_SLICES, "reviewed"), sourceSha256: sha };
}

export function targetFor(sha = SHA): AdoptTargetPorts {
  return {
    readSource: () => {
      if (sha === SHA) return SOURCE;
      if (sha === NEW_SHA) return NEW_SOURCE;
      throw new Error("unknown synthetic source");
    },
    launchStrategy: () => "transient-adopt-candidate",
  };
}
