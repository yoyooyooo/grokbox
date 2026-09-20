import { createHash } from "node:crypto";
import { Effect } from "effect";
import { UUID, ManagementClientError, incidentIdentity, normalizeIncidentChange, type IncidentOperation, type IncidentDetail } from "@grokbox/client/contract";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { observationError, projectIncident, type ManagementObservations } from "./observations.ts";

/** Scope the existing management table's UUID key, not a second operation DB.
 * Custom UUIDv8 carries the truncated SHA-256 key. Legacy unscoped rows can
 * never be read as this principal's new receipt. */
function storeRequestId(installationId: string, principalId: string, databaseId: string, requestId: string): string {
  const bytes = createHash("sha256").update(canonicalJson(["incident-management-v1", installationId, principalId, databaseId, requestId])).digest();
  bytes[6] = (bytes[6]! & 15) | 0x80; bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function projectError(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof BoxRuntimeError) {
    const errors = {
      monitor_database_changed: [409, "source_changed", "The observation database was replaced. Refresh the target; do not replay an old action into the new database."],
      monitor_revision_conflict: [409, "revision_conflict", "The incident changed. Read its current revision and review your draft before a new submission."],
      monitor_request_conflict: [409, "idempotency_conflict", "This request ID already belongs to different incident input."],
      monitor_incident_not_found: [404, "not_found", "The incident is not present in this observation database."],
      monitor_incident_resolved: [409, "incident_resolved", "The incident has already resolved; acknowledgement cannot reopen it."],
      monitor_invalid_snooze: [400, "invalid_input", "A new snooze deadline must be in the future and no more than 24 hours away."],
      monitor_invalid_management: [400, "invalid_input", "The incident action is invalid."],
      monitor_commit_unknown: [409, "operation_unknown", "The commit acknowledgement was lost. Query the original incident operation; do not resubmit."],
      monitor_management_full: [507, "store_full", "The incident receipt capacity is full. Existing recovery records have not been evicted."],
    } as const;
    const known = errors[error.message as keyof typeof errors];
    if (known) return new HttpFailure(known[0], known[1], known[2]);
  }
  return observationError(error);
}
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: projectError });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: projectError });
function receipt(installationId: string, databaseId: string, requestId: string, key: string, incidentId: string, action: "ack" | "snooze", appliedRevision: number): IncidentOperation {
  return { version: 1, requestId, operationRef: `incident-operation:${installationId}:${databaseId}:${key}`, databaseId,
    incidentRef: `incident:${installationId}:${databaseId}:${incidentId}`, action, beforeRevision: appliedRevision - 1,
    appliedRevision, state: "succeeded", repaired: false };
}

/** HTTP dispatch owns authorization; one existing SQLite transaction owns the
 * acknowledgement/snooze, management receipt and event. No native side effect. */
export function incidentApplication(installationId: string, source: ManagementObservations | undefined, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    yield* checked(() => {
      requireCapability(principal, method === "POST" ? "incidents.write" : url.pathname.startsWith("/v1/incident-operations/") ? "operations.read" : "observations.read");
      if (url.search) throw new HttpFailure(400, "invalid_input", "Incident detail and operation endpoints do not accept URL parameters.");
    });
    if (!source) return yield* Effect.fail(new HttpFailure(503, "source_unavailable", "The management service has no qualified incident store."));
    if (method === "POST" && url.pathname === "/v1/incident-changes") {
      const request = yield* checked(() => normalizeIncidentChange(input, installationId));
      const { databaseId, incidentId } = yield* checked(() => incidentIdentity(request.incidentRef, installationId));
      const key = storeRequestId(installationId, principal.id, databaseId, request.requestId);
      const prior = yield* io(() => source.managementReceipt(databaseId, key));
      if (prior) {
        const fingerprint = sha256Text(canonicalJson([incidentId, request.expectedRevision, request.action, request.untilMs ?? null]));
        if (prior.fingerprint !== fingerprint) return yield* Effect.fail(new HttpFailure(409, "idempotency_conflict", "This request ID already belongs to different incident input."));
        return receipt(installationId, databaseId, request.requestId, key, prior.incidentId, prior.action, prior.appliedRevision);
      }
      // Only the bounded SQLite commit checkpoint is non-interruptible; client
      // disconnection cannot cancel it and Server shutdown waits for settlement.
      const result = yield* io(() => source.manage({ requestId: key, databaseId, incidentId, expectedRevision: request.expectedRevision,
        action: request.action, ...(request.action === "snooze" ? { untilMs: request.untilMs } : {}), nowMs: Date.now() })).pipe(Effect.uninterruptible);
      return receipt(installationId, databaseId, request.requestId, key, result.incidentId, request.action, result.appliedRevision);
    }
    const operation = /^\/v1\/incident-operations\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && operation) {
      const [databaseId, requestId] = yield* checked(() => {
        if (!UUID.test(operation[1]!) || !UUID.test(operation[2]!)) throw new HttpFailure(400, "invalid_input", "The incident operation locator is invalid.");
        return [operation[1]!.toLowerCase(), operation[2]!.toLowerCase()] as const;
      });
      const key = storeRequestId(installationId, principal.id, databaseId, requestId);
      const row = yield* io(() => source.managementReceipt(databaseId, key));
      if (!row) return yield* Effect.fail(new HttpFailure(404, "not_found", "No committed receipt is recorded for this principal and request. This is not permission to repeat an uncertain action."));
      return receipt(installationId, databaseId, requestId, key, row.incidentId, row.action, row.appliedRevision);
    }
    const detail = /^\/v1\/incidents\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && detail) {
      const ref = yield* checked(() => decodeURIComponent(detail[1]!));
      const { databaseId, incidentId } = yield* checked(() => incidentIdentity(ref, installationId));
      const row = yield* io(() => source.incidentById(databaseId, incidentId));
      if (!row) return yield* Effect.fail(new HttpFailure(404, "not_found", "The incident is not present in this observation database."));
      return { source: "local-observations", databaseId, incident: projectIncident(installationId, databaseId, row) } satisfies IncidentDetail;
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The incident endpoint is not available."));
  });
}
