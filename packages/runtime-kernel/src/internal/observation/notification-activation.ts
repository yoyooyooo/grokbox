import { canonicalJson, sha256Text } from "../../hash.ts";
import { observationOwn as own } from "../contract/provider-observation.ts";
import { NotificationError, NOTIFICATION_DELIVERY_POLICY } from "./notification-contract.ts";
import type { NoticeReplayFence } from "./notice-replay-fence.ts";

/** The current ongoing grant is explicit enable, independent of optional test
 * delivery. Preserved historical grants are not current authorization and no
 * authorization proves a Bot report or user read. */
export const NOTICE_AUTHORIZATION_VERSION = 2;
export const NOTICE_WORKER_POLICY = Object.freeze({ idleMs: 5000, blockedMs: 30000, maxBlockedMs: 300000, maxPerCycle: 1 });
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const operation = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
const bad = (): never => { throw new NotificationError("invalid_automatic_authorization"); };
export type NoticeActivationCommand = { alias: string; expectedBindingRevision: number;
  expectedModelRevision: string; operationId: string; confirmed: boolean };
export function validateNoticeActivation(input: NoticeActivationCommand): NoticeActivationCommand {
  if (!input || Object.keys(input).some(k => !["alias", "expectedBindingRevision", "expectedModelRevision", "operationId", "confirmed"].includes(k))) return bad();
  const alias = own(input, "alias"), revision = own(input, "expectedBindingRevision"), model = own(input, "expectedModelRevision"), id = own(input, "operationId");
  if (typeof alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(alias) || !positive(revision) || revision >= Number.MAX_SAFE_INTEGER || !hash(model) || !operation(id)) return bad();
  if (own(input, "confirmed") !== true) throw new NotificationError("automatic_confirmation_required");
  return { alias, expectedBindingRevision: revision, expectedModelRevision: model, operationId: id, confirmed: true };
}
export const noticeActivationDigest = (input: NoticeActivationCommand) => sha256Text(canonicalJson(validateNoticeActivation(input)));
export type NoticeAuthorization = { version: 2; consent: "explicit-enable"; id: string; operationId: string; requestDigest: string; bindingRevision: number;
  activatedAtMs: number; modelRevision: string; qualificationRevision: string; nativeTurnObserved: false; includesExistingWork: false };
export function validateNoticeAuthorization(value: unknown): NoticeAuthorization {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  const keys = ["version", "consent", "id", "operationId", "requestDigest", "bindingRevision", "activatedAtMs", "modelRevision", "qualificationRevision", "nativeTurnObserved", "includesExistingWork"];
  if (Reflect.ownKeys(value).length !== keys.length) return bad();
  // Check descriptors before reading even the version. A prototype or getter
  // cannot grant authority and then disappear from its canonical persistence.
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) return bad();
  }
  const v = value as NoticeAuthorization;
  if (v.version !== NOTICE_AUTHORIZATION_VERSION || v.consent !== "explicit-enable"
    || !uuid(v.id) || !operation(v.operationId) || !hash(v.requestDigest) || !positive(v.bindingRevision)
    || !positive(v.activatedAtMs) || !hash(v.modelRevision) || !hash(v.qualificationRevision)
    || v.nativeTurnObserved !== false || v.includesExistingWork !== false) return bad();
  return structuredClone(v);
}

/** Receipts live atomically beside their private binding. They survive disable,
 * unbind and later enable operations; they cannot resurrect a past grant. */
export type ReceiverManagementReceipt = { version: 1; operationId: string; requestDigest: string; alias: string; bindingId: string;
  action: "enable" | "disable" | "unbind"; beforeRevision: number; appliedRevision: number; appliedAtMs: number;
  authorizationId: string | null; state: "succeeded" };
export function validateReceiverManagementReceipt(value: unknown): ReceiverManagementReceipt {
  const v = value as ReceiverManagementReceipt;
  if (!v || Object.keys(v).some(k => !["version", "operationId", "requestDigest", "alias", "bindingId", "action", "beforeRevision", "appliedRevision", "appliedAtMs", "authorizationId", "state"].includes(k))
    || v.version !== 1 || !operation(v.operationId) || !hash(v.requestDigest) || typeof v.alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.alias)
    || !uuid(v.bindingId) || !["enable", "disable", "unbind"].includes(v.action) || !positive(v.beforeRevision) || !positive(v.appliedRevision)
    || v.appliedRevision !== v.beforeRevision + 1 || !positive(v.appliedAtMs) || v.state !== "succeeded"
    || (v.action === "enable" ? !uuid(v.authorizationId) : v.authorizationId !== null)) return bad();
  return structuredClone(v);
}
export type AutomaticNoticeCycle = { state: "idle" | "blocked" | "processed" | "unavailable"; reason: string;
  workId?: string; authorizationId?: string; outcome?: string };
export type AutomaticNoticeWorkerStatus = { state: "starting" | "waiting" | "working" | "stopped"; cycles: number;
  lastCycleAtMs: number | null; lastCycle: AutomaticNoticeCycle | null; nextDelayMs: number;
  owner: "management-server"; automaticDiagnosis: false; automaticIssue: false; pollingCallsModels: false;
  serviceInstallation: "not_proven"; botReport: "not_observed"; userRead: "not_observed";
  replayFence?: ReturnType<NoticeReplayFence["status"]> };
export function projectNoticeWorker(value: unknown): AutomaticNoticeWorkerStatus {
  const state = own(value, "state"), cycles = own(value, "cycles"), at = own(value, "lastCycleAtMs"), delay = own(value, "nextDelayMs");
  if (!["starting", "waiting", "working", "stopped"].includes(String(state)) || typeof cycles !== "number" || !Number.isSafeInteger(cycles) || cycles < 0
    || !(at === null || positive(at)) || !positive(delay) || delay > NOTICE_WORKER_POLICY.maxBlockedMs || own(value, "owner") !== "management-server"
    || own(value, "automaticDiagnosis") !== false || own(value, "automaticIssue") !== false || own(value, "pollingCallsModels") !== false
    || own(value, "serviceInstallation") !== "not_proven" || own(value, "botReport") !== "not_observed" || own(value, "userRead") !== "not_observed") return bad();
  const last = own(value, "lastCycle"); let lastCycle: AutomaticNoticeCycle | null = null;
  if (last !== null) {
    const s = own(last, "state"), reason = own(last, "reason"), workId = own(last, "workId"), auth = own(last, "authorizationId"), outcome = own(last, "outcome");
    if (!["idle", "blocked", "processed", "unavailable"].includes(String(s)) || !["notifications_off", "routing_unsupported", "mode_unsupported", "target_missing", "target_disabled",
      "target_unconfigured", "intent_not_allowed", "data_policy_unsupported", "stopping", "automatic_not_authorized", "target_policy_changed", "clock_reversed", "installation_scope_changed",
      "no_fresh_work", "wake_budget", "delivery_preflight_blocked", "attempt_settled", "local_or_native_source_unavailable",
      "replay_clock_reversed", "replay_identity_unavailable", "prior_lifetime_attempt"].includes(String(reason))
      || !(workId === undefined || uuid(workId)) || !(auth === undefined || uuid(auth))
      || !(outcome === undefined || ["native-accepted", "definitely-not-accepted", "unknown", "already_attempted", "blocked", "unavailable"].includes(String(outcome)))) return bad();
    lastCycle = { state: s as AutomaticNoticeCycle["state"], reason: String(reason), ...(workId ? { workId } : {}), ...(auth ? { authorizationId: auth } : {}), ...(outcome ? { outcome: String(outcome) } : {}) };
  }
  const rawFence = own(value, "replayFence");
  let replayFence: AutomaticNoticeWorkerStatus["replayFence"];
  if (rawFence !== undefined) {
    const started = own(rawFence, "startedAtMs"), high = own(rawFence, "highWaterMs"), guarded = own(rawFence, "guardedWork"), max = own(rawFence, "maxEntries");
    if (!positive(started) || !positive(high) || high < started || !positive(max) || max > NOTIFICATION_DELIVERY_POLICY.maxAttempts
      || typeof guarded !== "number" || !Number.isSafeInteger(guarded) || guarded < 0 || guarded > max
      || own(rawFence, "policy") !== "worker-start-and-live-attempts-v1" || own(rawFence, "restoresExistingWork") !== false
      || own(rawFence, "scope") !== "automatic_notifications_only") return bad();
    replayFence = { policy: "worker-start-and-live-attempts-v1", startedAtMs: started, highWaterMs: high, guardedWork: guarded,
      maxEntries: max, restoresExistingWork: false, scope: "automatic_notifications_only" };
  }
  return { ...(replayFence ? { replayFence } : {}), state: state as AutomaticNoticeWorkerStatus["state"], cycles, lastCycleAtMs: at as number | null, lastCycle, nextDelayMs: delay,
    owner: "management-server", automaticDiagnosis: false, automaticIssue: false, pollingCallsModels: false, serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed" };
}

export function automaticAuthorizationView(value: NoticeAuthorization | undefined) {
  if (!value) return { state: "not_authorized" as const, includesExistingWork: false, nativeTurnObserved: false };
  const v = validateNoticeAuthorization(value);
  return { state: "authorized" as const, authorizationId: v.id, bindingRevision: v.bindingRevision,
    activatedAtMs: v.activatedAtMs, modelRevision: v.modelRevision,
    consent: v.consent, testRequired: false,
    nativeTurnObserved: false, includesExistingWork: false,
    currentEligibility: "requires_fresh_checks", hostInstallation: "not_checked" };
}
