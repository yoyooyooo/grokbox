import { ManagementClientError, UUID } from "./contract.ts";

export type ReceiverView = { receiverRef: string; bindingId: string; databaseId: string; alias: string; botRef: string; routineId: string;
  revision: number; state: "enrolling" | "prepared" | "disabled" | "unbound"; credentialStored: boolean; updatedAtMs: number;
  automatic: { authorizationId: string; activatedAtMs: number; modelRevision: string } | null;
  currentEligibility: "not-checked"; testRequired: false; nativeTurnObserved: false };
export type ReceiverList = { receivers: ReceiverView[]; coverage: "local-bindings"; maxReceivers: 8 };
export type ReceiverChangeRequest = { receiverRef: string; requestId: string; expectedRevision: number; confirmed: true } & (
  { action: "enable" | "test"; expectedModelRevision: string } | { action: "disable" | "unbind" });
export type ReceiverOperation = { version: 1; operationRef: string; requestId: string; receiverRef: string;
  action: "enable" | "disable" | "unbind"; beforeRevision: number; appliedRevision: number; appliedAtMs: number;
  authorizationId: string | null; state: "succeeded"; notificationSent: false; testRequired: false };
export type NotificationView = { notificationRef: string; databaseId: string; workId: string; purpose: "incident" | "test";
  incidentRef: string | null; evidenceRevision: number | null; state: "preparing" | "ready" | "blocked" | "completed" | "expired" | "superseded" | "unknown";
  createdAtMs: number; expiresAtMs: number;
  attempt: { attemptId: string; state: "reserved" | "attempting" | "native-accepted" | "definitely-not-accepted" | "unknown";
    targetAgentId: string; bindingRevision: number; envelopeDigest: string; envelopeBytes: number; reservedAtMs: number; settledAtMs: number | null } | null;
  automaticRetry: false; botReport: "not_observed"; userRead: "not_observed" };
export type NotificationList = { notifications: NotificationView[]; databaseId: string; nextCursor: string | null; coverage: "retained-work" };
export type NotificationTestOperation = { version: 1; operationRef: string; requestId: string; receiverRef: string;
  action: "test"; expectedRevision: number; state: "succeeded" | "refused" | "unknown"; delivery: NotificationView; enablesAutomatic: false };
export type ReceiverVerification = { receiverRef: string; revision: number; state: "ready" | "blocked"; reason: string;
  modelRevision: string | null; testRequired: false; notificationSent: false; grantsPermission: false };

export function notificationIdentity(ref: string, installationId: string, kind: "receiver" | "notification" = "receiver") {
  if (typeof installationId !== "string" || !UUID.test(installationId)) throw new ManagementClientError("wrong_installation", "Pin the connection before using notification references.");
  const parts = typeof ref === "string" ? ref.split(":") : [];
  if (parts.length !== 4 || parts[0] !== kind || parts.slice(1).some(part => !UUID.test(part))) throw new ManagementClientError("invalid_input", `An installation-scoped ${kind} reference is required.`);
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "This notification reference belongs to another installation.");
  return { databaseId: parts[2]!.toLowerCase(), id: parts[3]!.toLowerCase(), ref: `${kind}:${installationId.toLowerCase()}:${parts[2]!.toLowerCase()}:${parts[3]!.toLowerCase()}` };
}
export function normalizeReceiverChange(value: unknown, installationId: string): ReceiverChangeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagementClientError("invalid_input", "Invalid receiver action.");
  const data = value as Record<string, unknown>;
  const needsModel = data.action === "enable" || data.action === "test";
  if (Object.keys(data).some(key => !["receiverRef", "requestId", "expectedRevision", "confirmed", "action", ...(needsModel ? ["expectedModelRevision"] : [])].includes(key))
    || !["enable", "disable", "unbind", "test"].includes(String(data.action)) || typeof data.requestId !== "string" || !UUID.test(data.requestId)
    || !Number.isSafeInteger(data.expectedRevision) || Number(data.expectedRevision) < 1 || Number(data.expectedRevision) >= Number.MAX_SAFE_INTEGER
    || data.confirmed !== true || (needsModel && (typeof data.expectedModelRevision !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedModelRevision))))
    throw new ManagementClientError("invalid_input", "A receiver action requires its revision, persisted request UUID and explicit confirmation; enable/test also requires the reviewed model revision.");
  const ref = notificationIdentity(data.receiverRef as string, installationId).ref;
  return { ...structuredClone(data), receiverRef: ref, requestId: data.requestId.toLowerCase() } as ReceiverChangeRequest;
}
