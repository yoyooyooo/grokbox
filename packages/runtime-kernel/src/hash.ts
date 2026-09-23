import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
export { canonicalJson } from "./canonical-json.ts";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeSnapshotDigest(body: unknown): string {
  return sha256Text(canonicalJson(body));
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) throw new Error("empty needle");
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}
