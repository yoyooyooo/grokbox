/** Read-only execution-resource evidence; never an admission token. */
export type ExecutionCapacity = {
  version: 1;
  accepting: boolean;
  lifetimeStepLimit: null;
  activeSteps: number;
  hotStepRecords: number;
  hotTurns: number;
  pinnedTurns: number;
  pendingScopeReleases?: number;
  history: { kind: "leveldb" | "memory-test"; available: boolean; reads: number; writes: number; failures: number; lastError: "storage_unavailable" | null };
  counters: { accepted: number; duplicate: number; completed: number; reclaimedSteps: number; coldRestores: number; coldStores: number; cleanupFailures: number };
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function projectExecutionCapacity(value: unknown): ExecutionCapacity | undefined {
  if (!object(value) || value.version !== 1 || typeof value.accepting !== "boolean" || value.lifetimeStepLimit !== null
    || !object(value.history) || !object(value.counters)) return undefined;
  const scalar: Record<string, number> = {}, counters: Record<string, number> = {};
  for (const key of ["activeSteps", "hotStepRecords", "hotTurns", "pinnedTurns"]) {
    if (!number(value[key])) return undefined;
    scalar[key] = value[key];
  }
  for (const key of ["accepted", "duplicate", "completed", "reclaimedSteps", "coldRestores", "coldStores", "cleanupFailures"]) {
    if (!number(value.counters[key])) return undefined;
    counters[key] = value.counters[key];
  }
  if (value.pendingScopeReleases !== undefined) {
    if (!number(value.pendingScopeReleases)) return undefined;
    scalar.pendingScopeReleases = value.pendingScopeReleases;
  }
  const h = value.history;
  if ((h.kind !== "leveldb" && h.kind !== "memory-test") || typeof h.available !== "boolean"
    || !number(h.reads) || !number(h.writes) || !number(h.failures)
    || (h.lastError !== null && h.lastError !== "storage_unavailable") || value.accepting !== h.available) return undefined;
  return { version: 1, accepting: value.accepting, lifetimeStepLimit: null, ...scalar,
    history: { kind: h.kind, available: h.available, reads: h.reads, writes: h.writes, failures: h.failures, lastError: h.lastError }, counters } as ExecutionCapacity;
}
