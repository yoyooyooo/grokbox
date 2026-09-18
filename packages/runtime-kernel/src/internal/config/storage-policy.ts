import { ConfigError, isObject } from "./path.ts";
import { DAY_MS, MIB, OBSERVATION_RETENTION } from "../observation/retention-policy.ts";

export type StorageIntent = {
  policyRevision?: 1;
  diagnostics?: { targetBytes?: number; maxBytes?: number; reserveBytes?: number; detailDays?: number; summaryDays?: number };
  retention?: {
    monitor?: { maxBytes?: number };
    journal?: { segmentBytes?: number; maxBytes?: number; maxAgeMs?: number };
    process?: { segmentBytes?: number; maxBytes?: number; maxAgeMs?: number };
  };
};
export type EffectiveStorage = {
  policyRevision: 1;
  diagnostics: { targetBytes: number; maxBytes: number; reserveBytes: number; detailDays: number; summaryDays: number };
  retention: {
    monitor: { maxBytes: number };
    journal: { segmentBytes: number; maxBytes: number; maxAgeMs: number };
    process: { segmentBytes: number; maxBytes: number; maxAgeMs: number };
  };
};
const bad = (): never => { throw new ConfigError("config_invalid", "Storage policy has unknown fields or incompatible budgets."); };
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) return bad();
  // Configuration is JSON; do not evaluate getters/coercion supplied by callers.
  for (const key of Object.keys(value)) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) return bad();
  return value;
}
function number(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return bad();
  return value;
}
/** Versioned intent only, no IO, leases, grants or model authority. All owners
 * share this dependency domain; the two known journal roots have distinct
 * allocations, rather than a fresh installation budget per Bot or process. */
export function effectiveStorage(input?: StorageIntent): EffectiveStorage {
  const root = fields(input, ["policyRevision", "diagnostics", "retention"]);
  if (root.policyRevision !== undefined && root.policyRevision !== 1) return bad();
  const d = fields(root.diagnostics, ["targetBytes", "maxBytes", "reserveBytes", "detailDays", "summaryDays"]);
  const r = fields(root.retention, ["monitor", "journal", "process"]);
  const m = fields(r.monitor, ["maxBytes"]), j = fields(r.journal, ["segmentBytes", "maxBytes", "maxAgeMs"]), p = fields(r.process, ["segmentBytes", "maxBytes", "maxAgeMs"]);
  const diagnostics = {
    targetBytes: number(d.targetBytes, OBSERVATION_RETENTION.targetBytes, MIB, OBSERVATION_RETENTION.maxBytes),
    maxBytes: number(d.maxBytes, OBSERVATION_RETENTION.maxBytes, 4 * MIB, OBSERVATION_RETENTION.maxBytes),
    reserveBytes: number(d.reserveBytes, OBSERVATION_RETENTION.reserveBytes, MIB, OBSERVATION_RETENTION.maxBytes),
    detailDays: number(d.detailDays, OBSERVATION_RETENTION.detailMs / DAY_MS, 1, 30),
    summaryDays: number(d.summaryDays, OBSERVATION_RETENTION.summaryMs / DAY_MS, 1, 365),
  };
  const retention = {
    monitor: { maxBytes: number(m.maxBytes, OBSERVATION_RETENTION.monitorDatabaseBytes, MIB, OBSERVATION_RETENTION.monitorDatabaseBytes) },
    journal: { segmentBytes: number(j.segmentBytes, OBSERVATION_RETENTION.journalSegmentBytes, 128 * 1024, OBSERVATION_RETENTION.journalSegmentBytes),
      maxBytes: number(j.maxBytes, OBSERVATION_RETENTION.journalMaxBytes, 256 * 1024, OBSERVATION_RETENTION.journalMaxBytes),
      maxAgeMs: number(j.maxAgeMs, OBSERVATION_RETENTION.journalMaxAgeMs, 60_000, OBSERVATION_RETENTION.journalMaxAgeMs) },
    process: { segmentBytes: number(p.segmentBytes, OBSERVATION_RETENTION.processSegmentBytes, 2048, OBSERVATION_RETENTION.processSegmentBytes),
      maxBytes: number(p.maxBytes, OBSERVATION_RETENTION.processMaxBytes, 4096, OBSERVATION_RETENTION.processMaxBytes),
      maxAgeMs: number(p.maxAgeMs, OBSERVATION_RETENTION.journalMaxAgeMs, 60_000, OBSERVATION_RETENTION.journalMaxAgeMs) },
  };
  if (diagnostics.targetBytes >= diagnostics.maxBytes || diagnostics.reserveBytes >= diagnostics.maxBytes
    || diagnostics.targetBytes > diagnostics.maxBytes - diagnostics.reserveBytes || diagnostics.detailDays > diagnostics.summaryDays) return bad();
  for (const policy of [retention.journal, retention.process]) {
    if (policy.maxBytes < 2 * policy.segmentBytes || Math.ceil(policy.maxBytes / policy.segmentBytes) > 64) return bad();
  }
  // Reserve room for both known journal roots. Metadata/rollback/backup bytes
  // still require runtime admission; this arithmetic alone is NOT enforcement.
  const allocated = retention.monitor.maxBytes + 2 * retention.journal.maxBytes + retention.process.maxBytes;
  if (allocated > diagnostics.maxBytes - diagnostics.reserveBytes) return bad();
  return { policyRevision: 1, diagnostics, retention };
}
export function storageAllocation(policy: EffectiveStorage) {
  const dataBytes = policy.retention.monitor.maxBytes + 2 * policy.retention.journal.maxBytes + policy.retention.process.maxBytes;
  return { dataBytes, reserveBytes: policy.diagnostics.reserveBytes,
    unallocatedBytes: policy.diagnostics.maxBytes - policy.diagnostics.reserveBytes - dataBytes,
    journalRoots: 2, installationBudgetEnforced: false as const };
}
