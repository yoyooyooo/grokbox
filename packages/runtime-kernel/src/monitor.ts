import { projectNativeRunHealth, NATIVE_RUN_HEALTH_MAX_AGE_MS, type NativeRunHealth } from "./internal/observation/run-health.ts";
import { inspectOwnership, OWNERSHIP_MAX_TARGETS } from "./internal/contract/ownership.ts";
import { projectOwnershipReadObservation, type OwnershipReadObservation } from "./internal/contract/ownership-observation.ts";
import { observationOwn as own } from "./internal/contract/provider-observation.ts";

/** Observation policy is independent of the execution admission's 5s maximum age. */
export const MONITOR_POLICY = Object.freeze({
  intervalMs: 30_000, minIntervalMs: 10_000, maxIntervalMs: 300_000,
  readTimeoutMs: 10_000, staleAfterMs: 90_000, maxBackoffMs: 300_000, jitterRatio: 0.1,
  maxTargets: OWNERSHIP_MAX_TARGETS,
  // Housekeeping targets, never lifetime admission ceilings. Managed incident
  // facts and acknowledgements are not deleted merely to reach a row count.
  evidenceTarget: 50_000, retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxPage: 200, maxSnoozeMs: 24 * 60 * 60 * 1000, maxManagementReceipts: 10_000,
});
export const MONITOR_RULES = ["ownership_conflict", "ownership_changed", "observation_unavailable"] as const;
export type MonitorRule = typeof MONITOR_RULES[number];
export type MonitorHarness = "box" | "temporal" | null;
export type MonitorAgent = {
  agentId: string;
  state: "confirmed_box" | "confirmed_temporal" | "conflict" | "unconfirmed";
  serverId: string | null;
  serverHarness: MonitorHarness;
  localHarness: MonitorHarness;
};
export type MonitorSample = {
  sampleId: string; scopeId: string | null; gatewayEpoch: string | null;
  startedAtMs: number; completedAtMs: number; serverObservedAtMs: number | null;
  failure: "read_unavailable" | "scope_unavailable" | "invalid_observation" | null;
  agents: MonitorAgent[];
  readObservation?: OwnershipReadObservation;
  runObservation?: NativeRunHealth;
};
export type MonitorOwnershipDiagnosis = {
  version: 1; source: "monitor_ownership_read"; observedAtMs: number;
  failure: NonNullable<MonitorSample["failure"]>; readObservation?: OwnershipReadObservation;
};
/** Collector failures are observation failures, not failed model STEPs. */
export function projectMonitorOwnershipDiagnosis(value: unknown): MonitorOwnershipDiagnosis | undefined {
  try {
    const observedAtMs = own(value, "observedAtMs"), failure = own(value, "failure");
    if (own(value, "version") !== 1 || own(value, "source") !== "monitor_ownership_read" || typeof observedAtMs !== "number" || !time(observedAtMs)
      || typeof failure !== "string" || !["read_unavailable", "scope_unavailable", "invalid_observation"].includes(failure)) return undefined;
    const readObservation = projectOwnershipReadObservation(own(value, "readObservation"));
    return { version: 1, source: "monitor_ownership_read", observedAtMs, failure: failure as MonitorOwnershipDiagnosis["failure"],
      ...(readObservation ? { readObservation } : {}) };
  } catch { return undefined; }
}
export function monitorUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}
export function monitorScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
/** Empty installation membership is valid for local evidence intake. Native
 * ownership requests and samples still require at least one exact Bot. */
export function monitorTargets(ids: string[], installationOnly = false): string[] {
  if (!Array.isArray(ids) || !ids.length && !installationOnly || ids.length > MONITOR_POLICY.maxTargets || ids.some(id => !monitorUuid(id))) {
    throw new Error("monitor_invalid_targets");
  }
  return [...new Set(ids.map(id => id.toLowerCase()))].sort();
}
export function monitorInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < MONITOR_POLICY.minIntervalMs || value > MONITOR_POLICY.maxIntervalMs) {
    throw new Error("monitor_invalid_interval");
  }
  return value;
}
export function monitorDelay(intervalMs: number, failures: number, jitterUnit: number): number {
  monitorInterval(intervalMs);
  if (!Number.isSafeInteger(failures) || failures < 0 || !Number.isFinite(jitterUnit) || jitterUnit < 0 || jitterUnit > 1) throw new Error("monitor_invalid_delay");
  const base = Math.min(MONITOR_POLICY.maxBackoffMs, intervalMs * 2 ** Math.min(failures,5));
  return Math.min(MONITOR_POLICY.maxBackoffMs, Math.round(base * (1 + jitterUnit * MONITOR_POLICY.jitterRatio)));
}
function time(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

/** Copy only finite facts. Never persist raw native rows, reasons, paths or credentials. */
export function makeMonitorSample(input: {
  sampleId: string; agentIds: string[]; startedAtMs: number; completedAtMs: number;
  response?: { snapshot: unknown; gateway: { pid: number; startedAt: number } };
}): MonitorSample {
  const ids = monitorTargets(input.agentIds);
  if (!monitorUuid(input.sampleId) || !time(input.startedAtMs) || !time(input.completedAtMs)
    || input.completedAtMs < input.startedAtMs) throw new Error("monitor_invalid_sample");
  const result: MonitorSample = { sampleId: input.sampleId, scopeId: null, gatewayEpoch: null,
    startedAtMs: input.startedAtMs, completedAtMs: input.completedAtMs, serverObservedAtMs: null,
    failure: input.response ? "invalid_observation" : "read_unavailable", agents: [] };
  if (!input.response) return result;
  const gateway = input.response.gateway;
  if (!Number.isSafeInteger(gateway.pid) || gateway.pid < 1 || !time(gateway.startedAt)) return result;
  const native = projectNativeRunHealth(own(input.response.snapshot, "runObservation"));
  if (native && JSON.stringify([...native.targetIds].sort()) === JSON.stringify(ids) && native.observedAtMs <= input.completedAtMs
    && input.completedAtMs - native.observedAtMs <= NATIVE_RUN_HEALTH_MAX_AGE_MS) result.runObservation = native;
  const projected = inspectOwnership({ agentIds: ids, snapshot: input.response.snapshot });
  if (projected.readObservation) result.readObservation = projected.readObservation;
  // A failed native read also marks its scope unstable. Preserve the first
  // failure instead of mislabelling it as an independent scope failure.
  if (projected.serverRead.state !== "observed") return { ...result, failure: "read_unavailable" };
  if (!projected.scope?.stable || !monitorScope(projected.scope.id)) return { ...result, failure: "scope_unavailable" };
  const observed = Date.parse(projected.serverObservedAt ?? "");
  if (!Number.isFinite(observed) || observed > input.completedAtMs || observed < input.startedAtMs - MONITOR_POLICY.readTimeoutMs
    || input.completedAtMs - observed > MONITOR_POLICY.readTimeoutMs) return result;
  result.serverObservedAtMs = observed;
  result.scopeId = projected.scope.id;
  result.gatewayEpoch = `${gateway.pid}:${gateway.startedAt}`;
  result.failure = projected.serverRead.state === "observed" ? null : "read_unavailable";
  result.agents = projected.agents.map(row => ({
    agentId: row.agentId.toLowerCase(), state: row.state,
    serverId: typeof row.server?.serverId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(row.server.serverId) && !/secret|token|auth|password|api.?key|sk-/i.test(row.server.serverId) ? row.server.serverId : null,
    serverHarness: row.server?.harness === "box" || row.server?.harness === "temporal" ? row.server.harness : null,
    localHarness: row.local.stable && (row.local.after.harness === "box" || row.local.after.harness === "temporal") ? row.local.after.harness : null,
  }));
  return result;
}
export function confirmedObservation(row: MonitorAgent): boolean {
  return row.state !== "unconfirmed" && row.serverId !== null && row.serverHarness !== null;
}
export function monitorFreshness(lastSuccessMs: number | null, nowMs: number, latestSucceeded: boolean): "fresh" | "stale" | "unavailable" {
  if (!latestSucceeded || lastSuccessMs === null) return "unavailable";
  if (nowMs < lastSuccessMs || nowMs - lastSuccessMs > MONITOR_POLICY.staleAfterMs) return "stale";
  return "fresh";
}
