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

