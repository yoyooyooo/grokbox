import { notificationIdentity, type NotificationSendOperation, type NotificationSendRequest } from "./contract.ts";
import { exact, record, revision } from "./response-validation.ts";
import { notificationAttempt } from "./receiver-validation.ts";

export function notificationSendOperation(value: unknown, installationId: string, databaseId: string, requestId: string,
  request?: NotificationSendRequest): value is NotificationSendOperation {
  if (!record(value) || !exact(value, ["version", "operationRef", "requestId", "notificationRef", "receiverRef", "action", "expectedRevision",
    "expectedModelRevision", "state", "reason", "attempt", "enablesAutomatic", "botReport", "userRead"])
    || value.version !== 1 || value.requestId !== requestId || value.action !== "send"
    || typeof value.operationRef !== "string" || !value.operationRef.startsWith(`notification-operation:${installationId}:${databaseId}:`)
    || value.operationRef.split(":").length !== 4 || !revision(value.operationRef.split(":")[3])
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 || !revision(value.expectedModelRevision)
    || value.enablesAutomatic !== false || value.botReport !== "not_observed" || value.userRead !== "not_observed") return false;
  try {
    const receiver = notificationIdentity(value.receiverRef as string, installationId);
    const work = notificationIdentity(value.notificationRef as string, installationId, "notification");
    if (receiver.ref !== value.receiverRef || work.ref !== value.notificationRef || receiver.databaseId !== databaseId || work.databaseId !== databaseId) return false;
  } catch { return false; }
  if (value.attempt === null) {
    if (value.reason !== null && !["not-dispatched", "already-attempted", "permission-revoked", "cancelled-before-dispatch"].includes(String(value.reason))) return false;
    if (value.state !== (value.reason === null ? "unknown" : "refused")) return false;
  } else {
    if (!notificationAttempt(value.attempt) || value.reason !== null || value.attempt.bindingRevision !== value.expectedRevision) return false;
    const state = value.attempt.state === "native-accepted" ? "succeeded" : value.attempt.state === "definitely-not-accepted" ? "refused" : "unknown";
    if (value.state !== state) return false;
  }
  return !request || value.notificationRef === request.notificationRef && value.receiverRef === request.receiverRef
    && value.expectedRevision === request.expectedRevision && value.expectedModelRevision === request.expectedModelRevision;
}
