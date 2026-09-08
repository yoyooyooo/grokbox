import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Sort object keys; do not reorder semantic arrays. Used for selectionRevision and snapshotDigest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      Object.defineProperty(out, key, { value: canonicalize(record[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw new Error("canonicalJson cannot encode this value");
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
