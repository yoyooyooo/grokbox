import { ManagementClientError, UUID } from "./contract.ts";
import type { IncidentView } from "./observation-contract.ts";

export type IncidentChangeRequest = {
  requestId: string; incidentRef: string; expectedRevision: number;
} & ({ action: "ack"; untilMs?: never } | { action: "snooze"; untilMs: number });
export type IncidentDetail = { source: "local-observations"; databaseId: string; incident: IncidentView };
/** Historical acknowledgement of one management action, not current resolution,
 * notification delivery, execution authority, or a claim that a Bot was repaired. */
export type IncidentOperation = {
  version: 1; requestId: string; operationRef: string; databaseId: string; incidentRef: string;
  action: "ack" | "snooze"; beforeRevision: number; appliedRevision: number;
  state: "succeeded"; repaired: false;
};
export function incidentIdentity(ref: string, installationId: string): { databaseId: string; incidentId: string } {
  const parts = typeof ref === "string" ? ref.split(":") : [];
  if (parts.length !== 4 || parts[0] !== "incident" || !parts.slice(1).every(part => UUID.test(part))) {
    throw new ManagementClientError("invalid_input", "Use the installation- and database-scoped incident reference returned by a query.");
  }
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "The incident belongs to a different installation.");
  return { databaseId: parts[2]!.toLowerCase(), incidentId: parts[3]!.toLowerCase() };
}
export function normalizeIncidentChange(value: unknown, installationId: string): IncidentChangeRequest {
  const invalid = () => new ManagementClientError("invalid_input", "An incident action requires a stable reference, request UUID and integer revision; snooze also requires an absolute deadline.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const keys = input.action === "ack" ? ["requestId", "incidentRef", "expectedRevision", "action"]
    : input.action === "snooze" ? ["requestId", "incidentRef", "expectedRevision", "action", "untilMs"] : [];
  if (!keys.length || Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.requestId !== "string" || !UUID.test(input.requestId) || typeof input.incidentRef !== "string"
    || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER
    || (input.action === "snooze" && (!Number.isSafeInteger(input.untilMs) || Number(input.untilMs) < 1))) throw invalid();
  const { databaseId, incidentId } = incidentIdentity(input.incidentRef, installationId);
  return { requestId: input.requestId.toLowerCase(), incidentRef: `incident:${installationId.toLowerCase()}:${databaseId}:${incidentId}`,
    expectedRevision: Number(input.expectedRevision), ...(input.action === "ack" ? { action: "ack" } : { action: "snooze", untilMs: Number(input.untilMs) }) };
}
