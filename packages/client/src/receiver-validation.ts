import { UUID, notificationIdentity, type ReceiverChangeRequest, type ReceiverView, type ReceiverOperation, type NotificationView, type NotificationTestOperation } from "./contract.ts";
import { exact, record, revision } from "./response-validation.ts";
import { validateMaintenanceTask, validateMaintenanceReceipt, type MaintenanceTask, type MaintenanceReceipt } from "@grokbox/runtime-kernel/notification-tasks";
const number = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= 8_640_000_000_000_000;
function ref(value: unknown, installationId: string, kind: "receiver" | "notification") {
  try { return typeof value === "string" && notificationIdentity(value, installationId, kind).ref === value; } catch { return false; }
}
export function receiverView(value: unknown, installationId: string): value is ReceiverView {
  if (!record(value) || !exact(value, ["receiverRef", "bindingId", "databaseId", "alias", "botRef", "routineId", "revision", "state", "credentialStored", "updatedAtMs", "automatic", "currentEligibility", "testRequired", "nativeTurnObserved", "intent"])
    || !ref(value.receiverRef, installationId, "receiver") || typeof value.bindingId !== "string" || !UUID.test(value.bindingId)
    || typeof value.databaseId !== "string" || !UUID.test(value.databaseId) || value.receiverRef !== `receiver:${installationId}:${value.databaseId}:${value.bindingId}`
    || typeof value.alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.alias) || typeof value.botRef !== "string"
    || !value.botRef.startsWith(`bot:${installationId}:`) || !UUID.test(value.botRef.slice(41))
    || typeof value.routineId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.routineId)
    || !number(value.revision, 1) || !number(value.updatedAtMs, 1) || !["enrolling", "prepared", "disabled", "unbound"].includes(String(value.state))
    || typeof value.credentialStored !== "boolean" || value.currentEligibility !== "not-checked" || value.testRequired !== false || value.nativeTurnObserved !== false) return false;
  if (value.intent !== undefined && value.intent !== "diagnose-or-report") return false;
  if (value.automatic === null) return true;
  return value.state === "prepared" && value.credentialStored && record(value.automatic) && exact(value.automatic, ["authorizationId", "activatedAtMs", "modelRevision"])
    && typeof value.automatic.authorizationId === "string" && UUID.test(value.automatic.authorizationId) && number(value.automatic.activatedAtMs, 1) && revision(value.automatic.modelRevision);
}
export function receiverOperation(value: unknown, installationId: string, databaseId: string, requestId: string, request?: ReceiverChangeRequest): value is ReceiverOperation {
  if (!record(value) || !exact(value, ["version", "operationRef", "requestId", "receiverRef", "action", "beforeRevision", "appliedRevision", "appliedAtMs", "authorizationId", "state", "notificationSent", "testRequired"])
    || value.version !== 1 || value.requestId !== requestId || !ref(value.receiverRef, installationId, "receiver")
    || !(value.receiverRef as string).startsWith(`receiver:${installationId}:${databaseId}:`)
    || typeof value.operationRef !== "string" || !value.operationRef.startsWith(`receiver-operation:${installationId}:${databaseId}:`)
    || value.operationRef.split(":").length !== 4 || !revision(value.operationRef.split(":")[3]) || !["enable", "disable", "unbind"].includes(String(value.action))
    || !number(value.beforeRevision, 1) || value.appliedRevision !== value.beforeRevision + 1 || !number(value.appliedAtMs, 1)
    || (value.action === "enable" ? typeof value.authorizationId !== "string" || !UUID.test(value.authorizationId) : value.authorizationId !== null)
    || value.state !== "succeeded" || value.notificationSent !== false || value.testRequired !== false) return false;
  return !request || value.receiverRef === request.receiverRef && value.action === request.action && value.beforeRevision === request.expectedRevision;
}
export function notificationView(value: unknown, installationId: string, databaseId: string): value is NotificationView {
  if (!record(value) || !exact(value, ["notificationRef", "databaseId", "workId", "purpose", "incidentRef", "evidenceRevision", "state", "createdAtMs", "expiresAtMs", "attempt", "retry", "attemptHistory", "task", "taskReceipt", "automaticRetry", "botReport", "userRead"])
    || value.databaseId !== databaseId || !ref(value.notificationRef, installationId, "notification") || typeof value.workId !== "string" || !UUID.test(value.workId)
    || value.notificationRef !== `notification:${installationId}:${databaseId}:${value.workId}`
    || !["incident", "test"].includes(String(value.purpose)) || !["preparing", "ready", "blocked", "completed", "expired", "superseded", "unknown"].includes(String(value.state))
    || !number(value.createdAtMs, 1) || !number(value.expiresAtMs, 1) || value.expiresAtMs <= value.createdAtMs
    || (value.purpose === "test" ? value.incidentRef !== null || value.evidenceRevision !== null
      : typeof value.incidentRef !== "string" || !value.incidentRef.startsWith(`incident:${installationId}:${databaseId}:`) || !UUID.test(value.incidentRef.split(":")[3] ?? "") || value.incidentRef.split(":").length !== 4 || !number(value.evidenceRevision, 1))
    || value.automaticRetry !== false || value.botReport !== "not_observed" || value.userRead !== "not_observed") return false;
  if (value.task !== undefined || value.taskReceipt !== undefined) {
    if (value.task === null) { if (value.taskReceipt !== null) return false; }
    else try {
      const task = validateMaintenanceTask(value.task as MaintenanceTask);
      if (task.databaseId !== databaseId || task.taskId !== value.workId || task.evidenceRevision !== value.evidenceRevision
        || value.incidentRef !== `incident:${installationId}:${databaseId}:${task.incidentId}` || task.expiresAtMs !== value.expiresAtMs
        || !value.attempt || value.purpose !== "incident") return false;
      if (value.taskReceipt !== null) validateMaintenanceReceipt(value.taskReceipt as MaintenanceReceipt, task);
    } catch { return false; }
  }
  if (!notificationRetryView(value)) return false;
  if (value.attempt === null) return value.state !== "completed";
  return notificationAttempt(value.attempt) && (value.state !== "completed" || value.attempt.state === "native-accepted")
    && (!["reserved", "attempting", "unknown"].includes(value.attempt.state) || value.state === "unknown");
}
function notificationRetryView(value: Record<string, unknown>): boolean {
  if (value.retry === undefined && value.attemptHistory === undefined) return true;
  const retry = value.retry, history = value.attemptHistory;
  if (!record(retry) || !exact(retry, ["state", "reason", "attempts", "notBeforeMs"])
    || !["not_retryable", "waiting", "ready"].includes(String(retry.state))
    || !["not_attempted", "explicit_or_test_owned", "not_definitely_rejected", "retry_limit", "clock_reversed", "expired", "definite_rejection", "receiver_reported", "work_outcome_unknown"].includes(String(retry.reason))
    || !number(retry.attempts) || retry.attempts > 3 || !Array.isArray(history) || history.length !== retry.attempts) return false;
  const seen = new Set<string>();
  let previousSettled = 0;
  for (let index = 0; index < history.length; index++) {
    const row = history[index];
    if (!record(row) || !exact(row, ["attemptId", "state", "reservedAtMs", "settledAtMs"])
      || typeof row.attemptId !== "string" || !UUID.test(row.attemptId) || seen.has(row.attemptId)
      || !["reserved", "attempting", "native-accepted", "definitely-not-accepted", "unknown"].includes(String(row.state))
      || !number(row.reservedAtMs, 1) || row.reservedAtMs < previousSettled
      || (row.settledAtMs === null ? !["reserved", "attempting"].includes(String(row.state))
        : !number(row.settledAtMs, 1) || row.settledAtMs < row.reservedAtMs)
      || index < history.length - 1 && row.state !== "definitely-not-accepted") return false;
    seen.add(row.attemptId); previousSettled = Number(row.settledAtMs ?? row.reservedAtMs);
  }
  const last = history.at(-1);
  if (value.attempt === null ? history.length !== 0 : !record(value.attempt) || !last || last.attemptId !== value.attempt.attemptId
    || last.state !== value.attempt.state || last.reservedAtMs !== value.attempt.reservedAtMs || last.settledAtMs !== value.attempt.settledAtMs) return false;
  if (retry.reason === "work_outcome_unknown" && value.state !== "unknown") return false;
  if (retry.state === "not_retryable") return retry.notBeforeMs === null && retry.reason !== "definite_rejection";
  return value.state !== "unknown" && value.purpose === "incident" && retry.reason === "definite_rejection" && history.length > 0 && history.length < 3
    && last.state === "definitely-not-accepted" && number(retry.notBeforeMs, 1)
    && retry.notBeforeMs > last.settledAtMs && retry.notBeforeMs < Number(value.expiresAtMs);
}
export function notificationAttempt(a: unknown): a is NonNullable<NotificationView["attempt"]> {
  return record(a) && exact(a, ["attemptId", "state", "targetAgentId", "bindingRevision", "envelopeDigest", "envelopeBytes", "reservedAtMs", "settledAtMs"])
    && typeof a.attemptId === "string" && UUID.test(a.attemptId) && typeof a.targetAgentId === "string" && UUID.test(a.targetAgentId)
    && number(a.bindingRevision, 1) && revision(a.envelopeDigest) && number(a.envelopeBytes, 1) && a.envelopeBytes <= 8192
    && number(a.reservedAtMs, 1) && (a.settledAtMs === null || number(a.settledAtMs, 1) && a.settledAtMs >= a.reservedAtMs)
    && ["reserved", "attempting", "native-accepted", "definitely-not-accepted", "unknown"].includes(String(a.state))
    && (!["native-accepted", "definitely-not-accepted", "unknown"].includes(String(a.state)) || a.settledAtMs !== null);
}
export function notificationTestOperation(value: unknown, installationId: string, databaseId: string, requestId: string, request?: ReceiverChangeRequest): value is NotificationTestOperation {
  if (!record(value) || !exact(value, ["version", "operationRef", "requestId", "receiverRef", "action", "expectedRevision", "state", "delivery", "enablesAutomatic"])
    || value.version !== 1 || value.requestId !== requestId || !ref(value.receiverRef, installationId, "receiver") || !(value.receiverRef as string).startsWith(`receiver:${installationId}:${databaseId}:`)
    || typeof value.operationRef !== "string" || !value.operationRef.startsWith(`notification-test-operation:${installationId}:${databaseId}:`) || !revision(value.operationRef.split(":")[3]) || value.operationRef.split(":").length !== 4
    || value.action !== "test" || !number(value.expectedRevision, 1) || !notificationView(value.delivery, installationId, databaseId) || value.delivery.purpose !== "test"
    || value.enablesAutomatic !== false || value.state !== (value.delivery.state === "completed" ? "succeeded" : ["blocked", "expired"].includes(value.delivery.state) ? "refused" : "unknown")) return false;
  return !request || value.receiverRef === request.receiverRef && value.expectedRevision === request.expectedRevision;
}
