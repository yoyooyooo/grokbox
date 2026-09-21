import { ManagementClientError, UUID, notificationIdentity, type NotificationView } from "./contract.ts";

/** A user authorizes one existing incident work, never an arbitrary body or URL. */
export type NotificationSendRequest = {
  notificationRef: string;
  receiverRef: string;
  requestId: string;
  expectedRevision: number;
  expectedModelRevision: string;
  confirmed: true;
};
export type NotificationSendOperation = {
  version: 1;
  operationRef: string;
  requestId: string;
  notificationRef: string;
  receiverRef: string;
  action: "send";
  expectedRevision: number;
  expectedModelRevision: string;
  state: "succeeded" | "refused" | "unknown";
  reason: "not-dispatched" | "already-attempted" | "permission-revoked" | "cancelled-before-dispatch" | null;
  attempt: NotificationView["attempt"];
  enablesAutomatic: false;
  botReport: "not_observed";
  userRead: "not_observed";
};

export function normalizeNotificationSend(value: unknown, installationId: string): NotificationSendRequest {
  const fail = (): never => { throw new ManagementClientError("invalid_input", "A notification send requires exact work and receiver references, reviewed binding/model revisions, a persisted request UUID and explicit confirmation."); };
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const keys = ["notificationRef", "receiverRef", "requestId", "expectedRevision", "expectedModelRevision", "confirmed"];
  if (Reflect.ownKeys(value).length !== keys.length) return fail();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) return fail();
  }
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== "string" || !UUID.test(row.requestId) || row.confirmed !== true
    || typeof row.expectedRevision !== "number" || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || row.expectedRevision >= Number.MAX_SAFE_INTEGER
    || typeof row.expectedModelRevision !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedModelRevision)) return fail();
  const work = notificationIdentity(row.notificationRef as string, installationId, "notification");
  const receiver = notificationIdentity(row.receiverRef as string, installationId);
  if (work.databaseId !== receiver.databaseId) return fail();
  return { notificationRef: work.ref, receiverRef: receiver.ref, requestId: row.requestId.toLowerCase(),
    expectedRevision: row.expectedRevision, expectedModelRevision: row.expectedModelRevision, confirmed: true };
}
