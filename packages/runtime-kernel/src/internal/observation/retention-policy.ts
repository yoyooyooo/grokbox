export const MIB = 1024 * 1024;
export const DAY_MS = 86_400_000;
export const OBSERVATION_RETENTION = Object.freeze({
  policyRevision: 1,
  targetBytes: 256 * MIB, maxBytes: 512 * MIB, reserveBytes: 64 * MIB,
  detailMs: 7 * DAY_MS, summaryMs: 30 * DAY_MS,
  processSegmentBytes: 4 * MIB, processMaxBytes: 32 * MIB,
  journalSegmentBytes: 8 * MIB, journalMaxBytes: 128 * MIB,
  journalMaxAgeMs: 3 * DAY_MS,
  monitorDatabaseBytes: 128 * MIB, monitorReserveBytes: 8 * MIB,
  notificationTtlMs: 15 * 60_000, notificationReceiptMs: 14 * DAY_MS,
  dedupeMs: 30 * DAY_MS, orphanGraceMs: DAY_MS,
  leaseMs: 30 * 60_000, leaseMaxTotalMs: DAY_MS,
  maxSnapshotBytes: 512 * 1024, maxSnapshotFacts: 512,
  maxSnapshotRevisions: 3, maxAliasEntries: 4096, maxActiveLeases: 256, maintenanceBatch: 1000,
});
export type DiagnosticStoragePolicy = {
  targetBytes: number; maxBytes: number; reserveBytes: number; detailMs: number; summaryMs: number;
};
export function diagnosticStoragePolicy(value: Partial<DiagnosticStoragePolicy> = {}): DiagnosticStoragePolicy {
  const policy = { targetBytes: value.targetBytes ?? OBSERVATION_RETENTION.targetBytes,
    maxBytes: value.maxBytes ?? OBSERVATION_RETENTION.maxBytes, reserveBytes: value.reserveBytes ?? OBSERVATION_RETENTION.reserveBytes,
    detailMs: value.detailMs ?? OBSERVATION_RETENTION.detailMs, summaryMs: value.summaryMs ?? OBSERVATION_RETENTION.summaryMs };
  if (Object.values(policy).some(n => !Number.isSafeInteger(n) || n <= 0)
    || policy.targetBytes >= policy.maxBytes || policy.reserveBytes >= policy.maxBytes
    || policy.targetBytes > policy.maxBytes - policy.reserveBytes || policy.detailMs > policy.summaryMs) throw new Error("storage_invalid_policy");
  return policy;
}
export function diagnosticAdmission(policy: DiagnosticStoragePolicy, usedBytes: number, reservedBytes: number, incomingWorstCaseBytes: number) {
  if ([usedBytes, reservedBytes, incomingWorstCaseBytes].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("storage_invalid_usage");
  const projected = usedBytes + reservedBytes + incomingWorstCaseBytes;
  return { accepted: Number.isSafeInteger(projected) && projected <= policy.maxBytes - policy.reserveBytes,
    pressure: usedBytes >= policy.targetBytes, projectedBytes: projected, reserveBytes: policy.reserveBytes };
}
/** A durable watermark is not a substitute for trusted elapsed time. Suspicious
 * clock jumps stop destructive TTL work instead of renewing or expiring leases. */
export function retentionClock(nowMs: number, previousMs: number | null, maximumForwardMs = 7 * DAY_MS) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || (previousMs !== null && (!Number.isSafeInteger(previousMs) || previousMs < 1))) throw new Error("storage_invalid_clock");
  if (previousMs !== null && nowMs < previousMs) return { state: "clock_reversed" as const, nowMs: previousMs, mayExpire: false };
  if (previousMs !== null && nowMs - previousMs > maximumForwardMs) return { state: "clock_jump" as const, nowMs: previousMs, mayExpire: false };
  return { state: "observed" as const, nowMs, mayExpire: true };
}
