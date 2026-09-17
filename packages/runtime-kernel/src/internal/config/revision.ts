import { canonicalJson, sha256Text } from "../../hash.ts";
import { effectiveOps, type UnifiedConfig } from "./schema.ts";
import { isObject, type JsonObject } from "./path.ts";

export function configRevision(document: UnifiedConfig): string { return sha256Text(canonicalJson(document)); }
export function configurationRevisions(document: UnifiedConfig) {
  const ops = effectiveOps(document.ops);
  return {
    config: configRevision(document),
    client: sha256Text(canonicalJson(document.client)),
    daemon: sha256Text(canonicalJson(document.daemon ?? {})),
    desktop: sha256Text(canonicalJson(document.desktop ?? {})),
    runtime: sha256Text(canonicalJson(document.runtime ?? { desiredMode: "disabled" })),
    ops: sha256Text(canonicalJson(ops)),
    targets: Object.fromEntries(Object.entries(ops.targets as JsonObject).map(([key, value]) => [key, sha256Text(canonicalJson(value))])),
    support: sha256Text(canonicalJson(ops.support)),
  };
}
export function changedConfigPaths(before: unknown, after: unknown, path = ""): string[] {
  if (canonicalJson(before ?? null) === canonicalJson(after ?? null) && (before === undefined) === (after === undefined)) return [];
  if (isObject(before) || isObject(after)) {
    const left = isObject(before) ? before : {}; const right = isObject(after) ? after : {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    if (!keys.size) return [path];
    return [...keys].sort().flatMap((key) => changedConfigPaths(left[key], right[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return [path];
}
