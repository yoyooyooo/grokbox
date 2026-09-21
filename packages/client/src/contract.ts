import type { BotModelSelection, ModelChange, ModelPatch, ModelChangeRequest, ModelOperation } from "@grokbox/runtime-kernel/model-management";
import type { ModelCapabilities, ReasoningPolicy } from "@grokbox/runtime-kernel/selection";

export type { BotModelSelection, ModelChange, ModelPatch, ModelChangeRequest, ModelOperation };
export type { ObservationSnapshot, ObservedBot, ObservationFreshness, IncidentView, IncidentList, ObservationEvent, ObservationEventPage, ObservationWatchFrame } from "./observation-contract.ts";
export type { ManagementServiceView } from "./service-contract.ts";
export type { IncidentChangeRequest, IncidentDetail, IncidentOperation } from "./incident-contract.ts";
export { incidentIdentity, normalizeIncidentChange } from "./incident-contract.ts";
export type { NotificationWorkerView } from "./notification-contract.ts";
export type { ReceiverView, ReceiverList, ReceiverChangeRequest, ReceiverOperation, ReceiverVerification, NotificationView, NotificationList, NotificationTestOperation } from "./receiver-contract.ts";
export { notificationIdentity, normalizeReceiverChange } from "./receiver-contract.ts";
export * from "./notification-send-contract.ts";
export type { NotificationSettings, NotificationSettingsView, PublicRoutine, RoutineList, RoutineBlueprint, SetupKind, SetupRequest, SetupOperation } from "./setup-contract.ts";
export { normalizeSetupRequest, routineIdentity, routineReference, setupKind } from "./setup-contract.ts";
export * from "@grokbox/runtime-kernel/materials";
export * from "./protection-contract.ts";
export * from "./lifecycle-contract.ts";
export * from "./context-contract.ts";
export * from "./compaction-contract.ts";
export * from "./handover-contract.ts";
export { hostHealthView, type HostHealthView } from "./host-health-contract.ts";
export { hostLeaseOpportunityWindow } from "@grokbox/runtime-kernel/host-health";
export const API_VERSION = 1;
export const REQUEST_MAX_BYTES = 64 * 1024;
export const RESPONSE_MAX_BYTES = 256 * 1024;
export const CAPABILITIES = ["bots.read", "context.read", "context.write", "context.activate", "context.compact", "handover.write", "handover.messages", "handover.attest", "handover.retire", "lifecycle.write", "lifecycle.start", "lifecycle.messages", "models.read", "models.write", "operations.read", "observations.read", "incidents.write", "notifications.read", "notifications.write", "notifications.test", "notifications.send", "protection.read", "protection.write", "notifications.bind", "routines.read", "routines.write", "materials.read", "materials.search", "materials.content.read", "materials.write", "system.read", "console.grants.create"] as const;
export type Capability = typeof CAPABILITIES[number];
export type ConsoleGrant = { grantId: string; code: string; origin: string; expiresAt: number; persistence: "server-lifetime" };
export type ConsoleSession = {
  sessionId: string; principalId: string; capabilities: Capability[]; origin: string; expiresAt: number;
  csrfToken: string; persistence: "server-lifetime";
};
export type ManagementIdentity = { installationId: string; principalId: string; capabilities: Capability[]; apiVersion: 1 };
export const API_ERROR_CODES = ["invalid_input", "authentication_required", "permission_denied", "wrong_installation",
  "not_found", "revision_conflict", "idempotency_conflict", "operation_unknown", "compaction_failed", "protection_target_conflict", "incident_resolved", "notification_test_refused", "notification_send_refused", "source_changed", "model_in_use",
  "model_default_in_use", "model_default_missing", "model_source_read_only", "store_full", "unavailable",
  "source_unavailable", "source_invalid", "source_unauthorized", "source_timeout", "source_incomplete", "ambiguous_target", "caller_identity_unavailable", "cursor_gap", "internal_error", "protocol_error"] as const;
export type ApiErrorCode = typeof API_ERROR_CODES[number];
export type ApiError = { code: ApiErrorCode; message: string; details?: Record<string, unknown> };
export type ApiReply<T> = {
  schemaVersion: 1; installationId: string; invocationId: string;
} & ({ ok: true; data: T } | { ok: false; error: ApiError });
export type ModelView = {
  id: string; provider: string; model: string; endpoint: string | null; alias: string | null;
  configurationSource: "local" | "pi" | "builtin";
  capabilities: ModelCapabilities; contextWindowTokens: number | null;
  credential: { configured: boolean; source: "env" | "file" | "pi-provider" | "none" };
};
export type PageBound = "count" | "bytes" | null;
export type ModelList = { models: ModelView[]; revision: string; nextCursor: string | null; total: number; pageBound: PageBound };
export type DefaultModelView = { selection: { modelId: string; reasoning?: ReasoningPolicy } | null; revision: string };
export type BotModelView = {
  botRef: string; selection: BotModelSelection; revision: string;
  effectiveModel: { modelId: string; reasoning: ReasoningPolicy | null } | null;
  effectiveWhen: "next-turn"; currentTurn: "not-observed"; source: "model-configuration";
};
export type BotView = {
  botRef: string; id: string; name: string; title: string | null; description: string | null;
  nativeHarness: "box" | "temporal" | null; hidden: boolean | null; running: boolean | null;
  runningTurn: boolean | null; updatedAt: number | null; textTruncated: boolean;
  truncatedFields: Array<"name" | "title" | "description">;
  source: { kind: "native-gateway"; generation: string; pid: number; startedAt: number; observedAt: number };
  coverage: "current-snapshot";
};

export type BotList = {
  bots: BotView[]; membershipRevision: string; nextCursor: string | null; total: number; pageBound: PageBound;
  source: BotView["source"]; coverage: "current-snapshot"; consistency: "stable-membership-fresh-fields";
};
export type BotResolution = { bot: BotView; matchedBy: "id" | "name" | "title" };

export class ManagementClientError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly details?: Record<string, unknown>, readonly reply?: ApiReply<never>) {
    super(message);
    this.name = "ManagementClientError";
  }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeBotQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ManagementClientError("invalid_input", "The resolution query must be bounded text.");
  }
  return value.trim();
}
export function botIdForQuery(value: string, installationId: string): string | undefined {
  if (UUID.test(value) || /^bot:/i.test(value)) return botIdFromRef(value, installationId);
  if (/^[a-z-]+:[a-f0-9-]{36}:/i.test(value)) throw new ManagementClientError("invalid_input", "This reference is not a Bot reference.");
  return undefined;
}
export function botRef(installationId: string, botId: string): string {
  if (!UUID.test(installationId) || !UUID.test(botId)) throw new ManagementClientError("invalid_input", "A Bot reference requires stable installation and native IDs.");
  return `bot:${installationId.toLowerCase()}:${botId.toLowerCase()}`;
}
export function botIdFromRef(value: string, installationId: string): string {
  if (UUID.test(value)) return value.toLowerCase();
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "bot" || !UUID.test(parts[1]!) || !UUID.test(parts[2]!)) {
    throw new ManagementClientError("invalid_input", "Resolve the Bot to a native ID or scoped reference before this operation.");
  }
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "The Bot reference belongs to another installation.");
  return parts[2]!.toLowerCase();
}
