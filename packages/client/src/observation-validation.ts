import { UUID } from "./contract.ts";
import type { IncidentList, ObservationEventPage, ObservationSnapshot } from "./observation-contract.ts";
import type { ManagementServiceView } from "./service-contract.ts";
import { exact, record, revision } from "./response-validation.ts";

const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const maybeTime = (value: unknown) => value === null || time(value);
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const label = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value);
const workerLabel = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(value);
const harness = (value: unknown) => value === null || value === "box" || value === "temporal";
export function eventCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const [database, epoch, sequence, ...extra] = value.split(":");
  return id(database) && (epoch === "none" || id(epoch)) && typeof sequence === "string"
    && /^(0|[1-9][0-9]*)$/.test(sequence) && time(Number(sequence)) && extra.length === 0;
}
function incidentCursor(value: unknown, database: string, epoch: string | null): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 256) return false;
  const parts = value.split(":");
  return parts.length === 5 && parts[0] === database && parts[1] === (epoch ?? "none") && parts[2] === "incidents"
    && /^(0|[1-9][0-9]*)$/.test(parts[3]!) && time(Number(parts[3])) && id(parts[4]);
}
const botReference = (installation: string, agent: unknown, ref: unknown) => agent === null ? ref === null
  : id(agent) && ref === `bot:${installation}:${agent}`;

export function managementService(value: unknown): value is ManagementServiceView {
  if (!record(value) || !exact(value, ["component", "state", "observation", "workers", "effectivePolicy"]) || value.component !== "server"
    || !["running", "stopping", "stopped", "failed"].includes(String(value.state)) || !record(value.observation)) return false;
  const worker = value.observation;
  const observation = exact(worker, ["owner", "state", "reason", "desiredRevision", "collectorEpoch", "startedAtMs", "lastReceiptAtMs", "replacements", "targets", "createsDatabase", "notifiesDirectly", "bootInstalled"])
    && worker.owner === "management-server" && ["not_configured", "disabled", "starting", "running", "degraded", "blocked", "stopping", "stopped"].includes(String(worker.state))
    && (worker.reason === null || label(worker.reason)) && (worker.desiredRevision === null || revision(worker.desiredRevision))
    && (worker.collectorEpoch === null || id(worker.collectorEpoch)) && time(worker.startedAtMs) && maybeTime(worker.lastReceiptAtMs)
    && time(worker.replacements) && time(worker.targets) && worker.targets <= 32
    && worker.createsDatabase === false && worker.notifiesDirectly === false && worker.bootInstalled === false;
  if (!observation) return false;
  if (value.workers !== undefined) {
    if (!Array.isArray(value.workers) || value.workers.length !== 3) return false;
    const names = new Set<string>();
    for (const row of value.workers) {
      if (!record(row) || !exact(row, ["name", "owner", "started", "state", "reason", "qualified", "sideEffects"])
        || !["monitor", "notification-outbox", "protection"].includes(String(row.name)) || names.has(String(row.name))
        || row.owner !== "management-server" || typeof row.started !== "boolean" || !workerLabel(row.state)
        || (row.reason !== null && !workerLabel(row.reason)) || typeof row.qualified !== "boolean"
        || !["local-observation", "guarded-notification", "guarded-protection"].includes(String(row.sideEffects))) return false;
      names.add(String(row.name));
    }
    if (names.size !== 3) return false;
  }
  if (value.effectivePolicy !== undefined) {
    const policy = value.effectivePolicy;
    if (!record(policy) || !exact(policy, ["observation", "notifications", "protection", "storage"])
      || !record(policy.observation) || !exact(policy.observation, ["enabled", "targetCount", "notificationMode", "revision"])
      || typeof policy.observation.enabled !== "boolean" || !time(policy.observation.targetCount) || policy.observation.targetCount > 128
      || !["off", "local_only", "unknown"].includes(String(policy.observation.notificationMode))
      || !(policy.observation.revision === null || revision(policy.observation.revision))
      || !record(policy.notifications) || !exact(policy.notifications, ["enabled", "authorizationRequired", "directNative", "mode"])
      || typeof policy.notifications.enabled !== "boolean" || policy.notifications.authorizationRequired !== true || policy.notifications.directNative !== false
      || !["off", "local_only", "unknown"].includes(String(policy.notifications.mode))
      || !record(policy.protection) || !exact(policy.protection, ["enabled", "targetCount", "defaultProtection", "revision"])
      || typeof policy.protection.enabled !== "boolean" || !time(policy.protection.targetCount) || policy.protection.targetCount > 128
      || policy.protection.defaultProtection !== true || !(policy.protection.revision === null || revision(policy.protection.revision))
      || !record(policy.storage) || !exact(policy.storage, ["admissionScope", "writers", "installationBudgetEnforced"])
      || policy.storage.admissionScope !== "cooperating_diagnostic_writers" || !Array.isArray(policy.storage.writers)
      || policy.storage.writers.length !== 4 || new Set(policy.storage.writers).size !== 4
      || !policy.storage.writers.every(writer => ["monitor", "monitor-initialize", "journal", "process"].includes(String(writer)))
      || policy.storage.installationBudgetEnforced !== false) return false;
  }
  return true;
}

export function observationSnapshot(value: unknown, installation: string): value is ObservationSnapshot {
  return record(value) && exact(value, ["source", "admissionAuthority", "coverage", "databaseId", "collectorEpoch", "scopeId", "cursor", "readAtMs", "collector", "storage", "agents"])
    && value.source === "local-observations" && value.admissionAuthority === false && value.coverage === "watched-bots-only"
    && id(value.databaseId) && (value.collectorEpoch === null || id(value.collectorEpoch)) && (value.scopeId === null || revision(value.scopeId))
    && eventCursor(value.cursor) && value.cursor.startsWith(`${value.databaseId}:${value.collectorEpoch ?? "none"}:`) && time(value.readAtMs)
    && record(value.collector) && exact(value.collector, ["recordedRunning", "liveness", "lastHeartbeatMs"])
    && typeof value.collector.recordedRunning === "boolean" && value.collector.liveness === "not-probed" && maybeTime(value.collector.lastHeartbeatMs)
    && record(value.storage) && exact(value.storage, ["schemaVersion"])
    && time(value.storage.schemaVersion) && Number(value.storage.schemaVersion) >= 1
    && Array.isArray(value.agents) && value.agents.length <= 32 && new Set(value.agents.map(row => record(row) ? row.agentId : null)).size === value.agents.length
    && value.agents.every(row => record(row) && exact(row, ["botRef", "agentId", "lastKnown", "lastAttemptMs", "lastSuccessMs", "freshness"])
      && id(row.agentId) && botReference(installation, row.agentId, row.botRef) && maybeTime(row.lastAttemptMs) && maybeTime(row.lastSuccessMs)
      && ["fresh", "stale", "unavailable"].includes(String(row.freshness))
      && (row.lastKnown === null ? row.freshness === "unavailable" && row.lastSuccessMs === null
        : record(row.lastKnown) && exact(row.lastKnown, ["state", "serverHarness", "localHarness"])
          && ["confirmed_box", "confirmed_temporal", "conflict", "unconfirmed"].includes(String(row.lastKnown.state))
          && harness(row.lastKnown.serverHarness) && harness(row.lastKnown.localHarness))
      && (row.freshness !== "fresh" || row.lastSuccessMs !== null && record(value.collector) && value.collector.recordedRunning === true && Number(row.lastSuccessMs) <= Number(value.readAtMs)));
}

export function incidentList(value: unknown, installation: string, limit: number): value is IncidentList {
  if (!record(value) || !exact(value, ["source", "coverage", "databaseId", "collectorEpoch", "incidents", "nextCursor"])
    || value.source !== "local-observations" || value.coverage !== "retained-incidents" || !id(value.databaseId)
    || !(value.collectorEpoch === null || id(value.collectorEpoch)) || !incidentCursor(value.nextCursor, value.databaseId, value.collectorEpoch)
    || !Array.isArray(value.incidents) || value.incidents.length > limit || new Set(value.incidents.map(row => record(row) ? row.id : null)).size !== value.incidents.length) return false;
  return (value.nextCursor === null || value.incidents.length > 0) && value.incidents.every(row => record(row)
    && exact(row, ["id", "incidentRef", "scopeId", "agentId", "botRef", "rule", "status", "firstSeenAtMs", "lastSeenAtMs", "resolvedAtMs", "revision", "acknowledged", "snoozeUntilMs"])
    && id(row.id) && row.incidentRef === `incident:${installation}:${value.databaseId}:${row.id}` && revision(row.scopeId)
    && botReference(installation, row.agentId, row.botRef) && label(row.rule) && ["open", "resolved", "recorded"].includes(String(row.status))
    && time(row.firstSeenAtMs) && time(row.lastSeenAtMs) && row.lastSeenAtMs >= row.firstSeenAtMs && maybeTime(row.resolvedAtMs)
    && time(row.revision) && row.revision >= 1 && typeof row.acknowledged === "boolean" && maybeTime(row.snoozeUntilMs));
}

export function observationEvents(value: unknown, installation: string, limit: number, after?: string): value is ObservationEventPage {
  if (!record(value) || !exact(value, ["source", "coverage", "entries", "cursor", "hasMore", "retentionFloor", "gap"])
    || value.source !== "local-observations" || value.coverage !== "retained-events" || !eventCursor(value.cursor)
    || typeof value.hasMore !== "boolean" || !time(value.retentionFloor) || ![null, "history-truncated"].includes(value.gap as never)
    || !Array.isArray(value.entries) || value.entries.length > limit || value.hasMore && value.entries.length === 0) return false;
  const [database, epoch, end] = value.cursor.split(":");
  const previous = after?.split(":");
  if (after && (!eventCursor(after) || previous![0] !== database || previous![1] !== epoch || Number(end) < Number(previous![2]))) return false;
  let last = previous ? Number(previous[2]) : value.retentionFloor;
  for (const row of value.entries) {
    if (!record(row) || !exact(row, ["eventId", "seq", "collectorEpoch", "kind", "scopeId", "agentId", "botRef", "incidentId", "incidentRef", "observedAtMs", "previousHarness", "currentHarness", "observationIntervalStartMs"])
      || !id(row.eventId) || !time(row.seq) || row.seq <= last || !id(row.collectorEpoch) || !label(row.kind) || !revision(row.scopeId)
      || !botReference(installation, row.agentId, row.botRef) || !(row.incidentId === null ? row.incidentRef === null
        : id(row.incidentId) && row.incidentRef === `incident:${installation}:${database}:${row.incidentId}`)
      || !time(row.observedAtMs) || !harness(row.previousHarness) || !harness(row.currentHarness) || !maybeTime(row.observationIntervalStartMs)) return false;
    last = row.seq;
  }
  return Number(end) === last && new Set(value.entries.map(row => row.eventId)).size === value.entries.length
    && value.gap === (!after && value.retentionFloor > 0 ? "history-truncated" : null);
}
