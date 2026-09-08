import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
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

/** Launch never reopens the mutable authoring path. Only profile JSON is pinned, never Host source. */
export async function pinLaunchProfile(root: string, profile: PatchProfile): Promise<string> {
  const bytes = profileBytes(profile);
  const dir = join(root, "state", "launch-profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.json`);
  const file = await open(path, "wx+", 0o600);
  try {
    await file.writeFile(bytes, "utf8");
    const buffer = Buffer.alloc(Buffer.byteLength(bytes));
    const read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== buffer.length || !buffer.equals(Buffer.from(bytes))) throw new Error("launch-profile-readback-failed");
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
