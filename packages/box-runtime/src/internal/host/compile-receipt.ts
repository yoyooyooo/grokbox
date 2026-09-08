import { sha256Text } from "@grokbox/runtime-kernel/hash";
import type { PatchProfile } from "./profile.ts";

/** Hashes describe the bytes consumed by preload and the actual compile transform, not readiness. */
export type CompileReceipt = {
  profileId: string;
  profileSha256: string;
  sourceSha256: string;
  transformedSha256: string;
};

export function profileBytes(profile: PatchProfile): string {
  return `${JSON.stringify(profile)}\n`;
}

export function expectedCompileReceipt(profile: PatchProfile): CompileReceipt {
  return {
    profileId: profile.profileId,
    profileSha256: sha256Text(profileBytes(profile)),
    sourceSha256: profile.sourceSha256,
    transformedSha256: profile.transformedSourceSha256,
  };
}

export function compileReceiptAgrees(actual: CompileReceipt | undefined, expected: CompileReceipt): boolean {
  return Boolean(actual && actual.profileId === expected.profileId && actual.profileSha256 === expected.profileSha256 &&
    actual.sourceSha256 === expected.sourceSha256 && actual.transformedSha256 === expected.transformedSha256);
}
