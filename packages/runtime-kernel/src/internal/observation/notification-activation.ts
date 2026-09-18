import { canonicalJson, sha256Text } from "../../hash.ts";
import { observationOwn as own } from "../contract/provider-observation.ts";
import { NotificationError } from "./notification-contract.ts";

/** Ongoing permission is distinct from delivery evidence. The operator attests
 * to having observed the test reminder; grokbox proves only its stored HTTP
 * acceptance and fresh identity/model checks. Never synthesize that attestation
 * from a model answer, HTTP 200, or a preflight-ready result. */
export const NOTICE_AUTHORIZATION_VERSION = 1;
export const NOTICE_SEED_MAX_AGE_MS = 86_400_000;
export const NOTICE_WORKER_POLICY = Object.freeze({ idleMs: 5000, blockedMs: 30000, maxBlockedMs: 300000, maxPerCycle: 1 });
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const operation = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
const bad = (): never => { throw new NotificationError("invalid_automatic_authorization"); };
export type NoticeActivationCommand = { alias: string; fromWorkId: string; expectedBindingRevision: number;
  expectedModelRevision: string; operationId: string; confirmed: boolean; reminderObserved: boolean };
export function validateNoticeActivation(input: NoticeActivationCommand): NoticeActivationCommand {
  if (!input || Object.keys(input).some(k => !["alias", "fromWorkId", "expectedBindingRevision", "expectedModelRevision", "operationId", "confirmed", "reminderObserved"].includes(k))) return bad();
  const alias = own(input, "alias"), fromWorkId = own(input, "fromWorkId"), revision = own(input, "expectedBindingRevision"), model = own(input, "expectedModelRevision"), id = own(input, "operationId");
  if (typeof alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(alias) || !uuid(fromWorkId) || !positive(revision) || !hash(model) || !operation(id)) return bad();
  if (own(input, "confirmed") !== true || own(input, "reminderObserved") !== true) throw new NotificationError("automatic_confirmation_required");
  return { alias, fromWorkId, expectedBindingRevision: revision, expectedModelRevision: model, operationId: id, confirmed: true, reminderObserved: true };
}
export const noticeActivationDigest = (input: NoticeActivationCommand) => sha256Text(canonicalJson(validateNoticeActivation(input)));
export type NoticeAuthorization = { version: 1; id: string; operationId: string; requestDigest: string; bindingRevision: number;
  activatedAtMs: number; modelRevision: string; qualificationRevision: string;
  seedWorkId: string; seedAttemptId: string; seedEnvelopeDigest: string; seedAcceptedAtMs: number;
  receiverAttestation: "operator-confirmed-reminder"; nativeTurnObserved: false; includesExistingWork: false };
export function validateNoticeAuthorization(value: unknown): NoticeAuthorization {
  const v = value as NoticeAuthorization;
  if (!v || Object.keys(v).some(k => !["version", "id", "operationId", "requestDigest", "bindingRevision", "activatedAtMs", "modelRevision", "qualificationRevision", "seedWorkId", "seedAttemptId", "seedEnvelopeDigest", "seedAcceptedAtMs", "receiverAttestation", "nativeTurnObserved", "includesExistingWork"].includes(k))) return bad();
  for (const k of Object.keys(v)) { const d = Object.getOwnPropertyDescriptor(v, k); if (!d || !("value" in d)) return bad(); }
  if (v.version !== 1 || !uuid(v.id) || !operation(v.operationId) || !hash(v.requestDigest) || !positive(v.bindingRevision)
    || !positive(v.activatedAtMs) || !hash(v.modelRevision) || !hash(v.qualificationRevision) || !uuid(v.seedWorkId) || !uuid(v.seedAttemptId)
    || !hash(v.seedEnvelopeDigest) || !positive(v.seedAcceptedAtMs) || v.seedAcceptedAtMs > v.activatedAtMs
    || v.activatedAtMs - v.seedAcceptedAtMs > NOTICE_SEED_MAX_AGE_MS || v.receiverAttestation !== "operator-confirmed-reminder"
    || v.nativeTurnObserved !== false || v.includesExistingWork !== false) return bad();
  return { version: 1, id: v.id, operationId: v.operationId, requestDigest: v.requestDigest, bindingRevision: v.bindingRevision,
    activatedAtMs: v.activatedAtMs, modelRevision: v.modelRevision, qualificationRevision: v.qualificationRevision,
    seedWorkId: v.seedWorkId, seedAttemptId: v.seedAttemptId, seedEnvelopeDigest: v.seedEnvelopeDigest, seedAcceptedAtMs: v.seedAcceptedAtMs,
    receiverAttestation: "operator-confirmed-reminder", nativeTurnObserved: false, includesExistingWork: false };
}
export type AutomaticNoticeCycle = { state: "idle" | "blocked" | "processed" | "unavailable"; reason: string;
  workId?: string; authorizationId?: string; outcome?: string };
export type AutomaticNoticeWorkerStatus = { state: "starting" | "waiting" | "working" | "stopped"; cycles: number;
  lastCycleAtMs: number | null; lastCycle: AutomaticNoticeCycle | null; nextDelayMs: number;
  owner: "daemon-lifetime"; automaticDiagnosis: false; automaticIssue: false; pollingCallsModels: false;
  serviceInstallation: "not_proven"; botReport: "not_observed"; userRead: "not_observed" };
export function projectNoticeWorker(value: unknown): AutomaticNoticeWorkerStatus {
  const state = own(value, "state"), cycles = own(value, "cycles"), at = own(value, "lastCycleAtMs"), delay = own(value, "nextDelayMs");
  if (!["starting", "waiting", "working", "stopped"].includes(String(state)) || typeof cycles !== "number" || !Number.isSafeInteger(cycles) || cycles < 0
    || !(at === null || positive(at)) || !positive(delay) || delay > NOTICE_WORKER_POLICY.maxBlockedMs || own(value, "owner") !== "daemon-lifetime"
    || own(value, "automaticDiagnosis") !== false || own(value, "automaticIssue") !== false || own(value, "pollingCallsModels") !== false
    || own(value, "serviceInstallation") !== "not_proven" || own(value, "botReport") !== "not_observed" || own(value, "userRead") !== "not_observed") return bad();
  const last = own(value, "lastCycle"); let lastCycle: AutomaticNoticeCycle | null = null;
  if (last !== null) {
    const s = own(last, "state"), reason = own(last, "reason"), workId = own(last, "workId"), auth = own(last, "authorizationId"), outcome = own(last, "outcome");
    if (!["idle", "blocked", "processed", "unavailable"].includes(String(s)) || !["notifications_off", "routing_unsupported", "mode_unsupported", "target_missing", "target_disabled",
      "target_unconfigured", "intent_not_allowed", "data_policy_unsupported", "stopping", "automatic_not_authorized", "target_policy_changed", "clock_reversed", "installation_scope_changed",
      "no_fresh_work", "wake_budget", "delivery_preflight_blocked", "attempt_settled", "local_or_native_source_unavailable"].includes(String(reason))
      || !(workId === undefined || uuid(workId)) || !(auth === undefined || uuid(auth))
      || !(outcome === undefined || ["native-accepted", "definitely-not-accepted", "unknown", "already_attempted", "blocked", "unavailable"].includes(String(outcome)))) return bad();
    lastCycle = { state: s as AutomaticNoticeCycle["state"], reason: String(reason), ...(workId ? { workId } : {}), ...(auth ? { authorizationId: auth } : {}), ...(outcome ? { outcome: String(outcome) } : {}) };
  }
  return { state: state as AutomaticNoticeWorkerStatus["state"], cycles, lastCycleAtMs: at as number | null, lastCycle, nextDelayMs: delay,
    owner: "daemon-lifetime", automaticDiagnosis: false, automaticIssue: false, pollingCallsModels: false, serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed" };
}

export function automaticAuthorizationView(value: NoticeAuthorization | undefined) {
  if (!value) return { state: "not_authorized" as const, includesExistingWork: false, nativeTurnObserved: false };
  const v = validateNoticeAuthorization(value);
  return { state: "authorized" as const, authorizationId: v.id, bindingRevision: v.bindingRevision,
    activatedAtMs: v.activatedAtMs, modelRevision: v.modelRevision, seedWorkId: v.seedWorkId,
    receiverAttestation: v.receiverAttestation, nativeTurnObserved: false, includesExistingWork: false,
    currentEligibility: "requires_fresh_checks", hostInstallation: "not_checked" };
}
