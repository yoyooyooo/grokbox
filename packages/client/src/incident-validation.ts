import { UUID, incidentIdentity, type IncidentChangeRequest, type IncidentDetail, type IncidentOperation } from "./contract.ts";
import { record, exact } from "./response-validation.ts";
import { incidentList } from "./observation-validation.ts";

export function incidentDetail(value: unknown, installationId: string, ref: string): value is IncidentDetail {
  if (!record(value) || !exact(value, ["source", "databaseId", "incident"]) || value.source !== "local-observations"
    || !record(value.incident) || value.incident.incidentRef !== ref) return false;
  return incidentList({ source: value.source, databaseId: value.databaseId, coverage: "retained-incidents", collectorEpoch: null,
    incidents: [value.incident], nextCursor: null }, installationId, 1);
}
export function incidentOperation(value: unknown, installationId: string, databaseId: string, requestId: string, expected?: IncidentChangeRequest): value is IncidentOperation {
  if (!record(value) || !exact(value, ["version", "requestId", "operationRef", "databaseId", "incidentRef", "action", "beforeRevision", "appliedRevision", "state", "repaired"])
    || value.version !== 1 || value.requestId !== requestId || !UUID.test(databaseId) || value.databaseId !== databaseId
    || typeof value.operationRef !== "string" || !value.operationRef.startsWith(`incident-operation:${installationId}:${databaseId}:`)
    || !UUID.test(value.operationRef.slice(`incident-operation:${installationId}:${databaseId}:`.length)) || value.state !== "succeeded" || value.repaired !== false
    || typeof value.incidentRef !== "string" || !["ack", "snooze"].includes(String(value.action))
    || !Number.isSafeInteger(value.beforeRevision) || Number(value.beforeRevision) < 1 || !Number.isSafeInteger(value.appliedRevision)
    || value.appliedRevision !== Number(value.beforeRevision) + 1) return false;
  try { if (incidentIdentity(value.incidentRef, installationId).databaseId !== databaseId) return false; } catch { return false; }
  return !expected || value.incidentRef === expected.incidentRef && value.beforeRevision === expected.expectedRevision && value.action === expected.action;
}
