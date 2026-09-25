import { canonicalJson, sha256Text } from "../../hash.ts";
import { observationOwn as own } from "../contract/provider-observation.ts";
import { BOT_NOTICE_SUMMARIES, type BotIncidentNotice } from "./evidence-views.ts";
import { FAILURE_CATEGORIES } from "../contract/failure-summary.ts";
import { EVIDENCE_REQUIREMENTS } from "./evidence-contract.ts";
import { validateMaintenanceTask, type MaintenanceTask } from "./notification-task.ts";

export const NOTIFICATION_DELIVERY_POLICY = Object.freeze({ maxBytes: 8192, budgetWindowMs: 86_400_000,
  maxAttempts: 4096, maxAttemptsPerWork: 3, retryDelaysMs: Object.freeze([30_000, 120_000]),
  bindingFreshMs: 5000, deliveryTimeoutMs: 10_000 });
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const limit = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1000;
const alias = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v);
const key = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v);
const nativeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
export class NotificationError extends Error {
  constructor(readonly reason: string) { super(`notification_${reason}`); this.name = "NotificationError"; }
}
const fail = (): never => { throw new NotificationError("invalid_contract"); };
export type NotificationScope = { databaseId: string; scopeId: string };
export type NotificationTarget = { alias: string; agentId: string; routineKey: string; policyRevision: string;
  dataPolicy: "safe-summary"; installationLimit: number; targetLimit: number; intent?: "diagnose-or-report" };
export type NotificationRoute = { state: "selected"; target: NotificationTarget } | { state: "blocked"; reason:
  "notifications_off" | "routing_unsupported" | "mode_unsupported" | "target_missing" | "target_disabled" | "target_unconfigured" | "intent_not_allowed" | "data_policy_unsupported" };

/** Observation does not grant, revoke, or change the fixed recipient policy.
 * Excluding this new independent field also preserves pre-existing notice
 * fingerprints; a read-only switch must not require paid receivers to rebind. */
export function notificationPolicyRevision(ops: unknown, intent: "brief-notice" | "diagnose-or-report" = "brief-notice"): string {
  const { observation: _observation, maintainer, ...delivery } = ops as Record<string, unknown>;
  if (intent === "diagnose-or-report") return sha256Text(canonicalJson({ lane: "maintenance-analysis-v1",
    enabled: own(ops, "enabled"), maintainer, diagnostics: own(ops, "diagnostics"), maintenance: own(ops, "maintenance"), targets: own(ops, "targets") }));
  return sha256Text(canonicalJson(delivery));
}

/** Takes the already validated effective ops domain, never anything in an event
 * payload. Only the default single-target path is admitted; no fallback or LLM. */
export function selectNotificationTarget(ops: unknown, intent: "brief-notice" | "diagnose-or-report" = "brief-notice"): NotificationRoute {
  const notifications = own(ops, "notifications"), routing = own(ops, "routing"), maintainer = own(ops, "maintainer");
  const analysis = intent === "diagnose-or-report";
  const blocked = (reason: Extract<NotificationRoute, { state: "blocked" }>["reason"]): NotificationRoute => ({ state: "blocked", reason });
  if (own(ops, "enabled") !== true || (analysis ? own(maintainer, "enabled") !== true : own(notifications, "mode") === "off")) return blocked("notifications_off");
  if (analysis) {
    if (own(own(ops, "diagnostics"), "mode") !== "automatic-bounded") return blocked("intent_not_allowed");
  } else {
    if (own(notifications, "mode") !== "actionable-user" || own(notifications, "channel") !== "bot-webhook"
      || own(notifications, "allowDuplicateDelivery") !== false || own(notifications, "digest") !== false) return blocked("mode_unsupported");
    if (own(routing, "enabled") !== false) return blocked("routing_unsupported");
  }
  const name = own(analysis ? maintainer : routing, analysis ? "target" : "defaultTarget"), t = alias(name) ? own(own(ops, "targets"), name) : undefined;
  if (!alias(name) || !t) return blocked("target_missing");
  if (own(t, "enabled") !== true) return blocked("target_disabled");
  const agentId = own(t, "agentId"), routineKey = own(t, "routineKey");
  if (!uuid(agentId) || !key(routineKey)) return blocked("target_unconfigured");
  const intents = own(t, "allowedIntents");
  if (!Array.isArray(intents) || !intents.includes(intent)) return blocked("intent_not_allowed");
  if (own(t, "dataPolicy") !== "safe-summary") return blocked("data_policy_unsupported");
  const installationLimit = own(analysis ? maintainer : notifications, "maxAutomaticWakeupsPerDay"), targetLimit = own(t, "maxAutomaticWakeupsPerDay") ?? installationLimit;
  if (!limit(installationLimit) || !limit(targetLimit)) return fail();
  // The reserve is never borrowed by this first lane. All attempts use the
  // ordinary cap, counted across aliases of the same actual Agent identity.
  return { state: "selected", target: { alias: name, agentId, routineKey, policyRevision: notificationPolicyRevision(ops, intent),
    dataPolicy: "safe-summary", installationLimit, targetLimit, ...(analysis ? { intent: "diagnose-or-report" as const } : {}) } };
}
export function validateNotificationTarget(v: NotificationTarget): NotificationTarget {
  if (!alias(v?.alias) || !uuid(v.agentId) || !key(v.routineKey) || !hash(v.policyRevision) || v.dataPolicy !== "safe-summary"
    || !limit(v.installationLimit) || !limit(v.targetLimit) || v.intent !== undefined && v.intent !== "diagnose-or-report") return fail();
  return { alias: v.alias, agentId: v.agentId, routineKey: v.routineKey, policyRevision: v.policyRevision,
    dataPolicy: "safe-summary", installationLimit: v.installationLimit, targetLimit: v.targetLimit,
    ...(v.intent ? { intent: v.intent } : {}) };
}
/** Obtained from a trusted, installation-scoped pairing owner. Not config or
 * user-supplied JSON. No endpoint/key is carried into evidence or the outbox. */
export type NotificationBinding = { bindingId: string; revision: number; databaseId: string; scopeId: string;
  targetAlias: string; agentId: string; routineKey: string; routineId: string; routineRevision: string;
  modelRevision: string; qualificationRevision: string; policyRevision: string;
  dataPolicy: "safe-summary"; receiverMode: "notify_then_end" | "claim_analyze_report"; observedAtMs: number; validUntilMs: number };
export function validateNotificationBinding(v: NotificationBinding, target: NotificationTarget, scope: NotificationScope, atMs: number): NotificationBinding {
  validateNotificationTarget(target);
  if (!uuid(scope?.databaseId) || !hash(scope.scopeId) || !positive(atMs) || !v || !uuid(v.bindingId) || !positive(v.revision)
    || v.databaseId !== scope.databaseId || v.scopeId !== scope.scopeId || v.targetAlias !== target.alias
    || v.agentId !== target.agentId || v.routineKey !== target.routineKey || v.policyRevision !== target.policyRevision
    || !nativeId(v.routineId) || !hash(v.routineRevision) || !hash(v.modelRevision) || !hash(v.qualificationRevision)
    || v.dataPolicy !== "safe-summary" || v.receiverMode !== (target.intent === "diagnose-or-report" ? "claim_analyze_report" : "notify_then_end") || !positive(v.observedAtMs) || !positive(v.validUntilMs)
    || atMs < v.observedAtMs || atMs >= v.validUntilMs || v.validUntilMs - v.observedAtMs > NOTIFICATION_DELIVERY_POLICY.bindingFreshMs) return fail();
  return { bindingId: v.bindingId, revision: v.revision, databaseId: v.databaseId, scopeId: v.scopeId,
    targetAlias: v.targetAlias, agentId: v.agentId, routineKey: v.routineKey, routineId: v.routineId, routineRevision: v.routineRevision,
    modelRevision: v.modelRevision, qualificationRevision: v.qualificationRevision, policyRevision: v.policyRevision,
    dataPolicy: v.dataPolicy, receiverMode: v.receiverMode, observedAtMs: v.observedAtMs, validUntilMs: v.validUntilMs };
}
export function notificationBindingIdentity(v: NotificationBinding) {
  const { observedAtMs: _observed, validUntilMs: _until, ...fixed } = v;
  return sha256Text(canonicalJson(fixed));
}
export type BotAnalysisNotice = Omit<BotIncidentNotice, "intent" | "behavior" | "automaticDiagnosis"> & {
  intent: "diagnose-or-report"; behavior: "claim_analyze_report"; automaticDiagnosis: true };
export type NotificationEnvelope = { schemaVersion: 1; kind: "grokbox.ops.notification"; intent: "brief-notice" | "diagnose-or-report";
  deliveryId: string; workId: string; routeDecisionId: string; createdAtMs: number; expiresAtMs: number;
  target: { agentId: string; routineId: string; bindingId: string; bindingRevision: number }; notice: BotIncidentNotice | BotTestNotice | BotAnalysisNotice; task?: MaintenanceTask };
export type BotTestNotice = { schemaVersion: 1; kind: "grokbox.ops.notification-test"; intent: "brief-notice"; testId: string;
  createdAtMs: number; expiresAtMs: number; summary: typeof NOTIFICATION_TEST_SUMMARY; behavior: "notify_then_end";
  automaticDiagnosis: false; automaticIssue: false; replayAuthorized: false; commands: [] };
export const NOTIFICATION_TEST_SUMMARY = "This is an explicitly requested notification test, not an incident. Briefly confirm receipt and end; do not run tools or diagnose anything.";
export function notificationTestNotice(testId: string, createdAtMs: number, expiresAtMs: number): BotTestNotice {
  if (!uuid(testId) || !positive(createdAtMs) || !positive(expiresAtMs) || expiresAtMs <= createdAtMs) return fail();
  return { schemaVersion: 1, kind: "grokbox.ops.notification-test", intent: "brief-notice", testId, createdAtMs, expiresAtMs,
    summary: NOTIFICATION_TEST_SUMMARY, behavior: "notify_then_end", automaticDiagnosis: false, automaticIssue: false, replayAuthorized: false, commands: [] };
}
function testNotice(value: unknown): BotTestNotice {
  const v = value as BotTestNotice;
  if (!v || canonicalJson(v) !== canonicalJson(notificationTestNotice(v.testId, v.createdAtMs, v.expiresAtMs))) return fail();
  return notificationTestNotice(v.testId, v.createdAtMs, v.expiresAtMs);
}
export type FrozenNotification = { schemaVersion: 1; scope: NotificationScope; target: NotificationTarget; binding: NotificationBinding;
  bindingDigest: string; envelopeDigest: string; envelopeBytes: number; workId: string; attemptId: string;
  incidentId: string | null; evidenceRevision: number | null; expiresAtMs: number; retryOf?: string; task?: MaintenanceTask };
export type NotificationReservation = { state: "reserved"; frozen: FrozenNotification; envelope: NotificationEnvelope }
  | { state: "blocked"; reason: string } | { state: "already_attempted"; attemptState: string };
export type NativeNotificationResult = { state: "native-accepted"; receiptId?: string }
  | { state: "definitely-not-accepted"; reason: "revoked" | "expired" | "unsupported" | "policy_changed" | "native_rejected" }
  | { state: "unknown"; reason: "transport_failure" | "invalid_receipt" | "acknowledgement_lost" };
export function projectNativeNotificationResult(value: unknown): NativeNotificationResult {
  const state = own(value, "state"), reason = own(value, "reason"), receiptId = own(value, "receiptId");
  if (state === "native-accepted" && (receiptId === undefined || uuid(receiptId) || hash(receiptId))) return { state, ...(receiptId ? { receiptId: String(receiptId) } : {}) };
  if (state === "definitely-not-accepted" && ["revoked", "expired", "unsupported", "policy_changed", "native_rejected"].includes(String(reason)))
    return { state, reason: reason as Extract<NativeNotificationResult, { state: "definitely-not-accepted" }>["reason"] };
  if (state === "unknown" && ["transport_failure", "invalid_receipt", "acknowledgement_lost"].includes(String(reason))) return { state, reason: reason as "transport_failure" | "invalid_receipt" | "acknowledgement_lost" };
  return { state: "unknown", reason: "invalid_receipt" };
}
function deliveryNotice(v: BotIncidentNotice): BotIncidentNotice {
  const generic = "观察到尚未分类的异常，已有证据与缺口已保存。";
  if (!v || v.schemaVersion !== 1 || v.kind !== "grokbox.ops.notification" || v.intent !== "brief-notice"
    || !uuid(v.incidentId) || !positive(v.evidenceRevision) || !positive(v.capturedAtMs)
    || ![...Object.values(BOT_NOTICE_SUMMARIES), generic].includes(v.summary)
    || ![...FAILURE_CATEGORIES, "host_compatibility", "native_failure", "suspected_stall", "observation_gap", "continuity_impact"].includes(v.classification)
    || v.rootCause !== "not_proven" || v.behavior !== "notify_then_end" || v.automaticDiagnosis !== false
    || v.automaticIssue !== false || v.replayAuthorized !== false || v.evidence?.tier !== "detail" || !positive(v.evidence.expiresAtMs)
    || !Array.isArray(v.evidence.missingRequirements) || v.evidence.missingRequirements.length > 8
    || !v.evidence.missingRequirements.every(r => (EVIDENCE_REQUIREMENTS as readonly string[]).includes(r))) return fail();
  const commands: BotIncidentNotice["commands"] = [{ commandId: "monitor-incident-v1", argv: ["grokbox", "runtime", "monitor", "incident", v.incidentId,
    "--evidence-revision", String(v.evidenceRevision), "--json"], requires: "box-local", readOnly: true }];
  if (canonicalJson(v.commands) !== canonicalJson(commands)) return fail();
  return { schemaVersion: 1, kind: "grokbox.ops.notification", intent: "brief-notice", incidentId: v.incidentId,
    evidenceRevision: v.evidenceRevision, capturedAtMs: v.capturedAtMs, summary: v.summary, classification: v.classification,
    rootCause: "not_proven", commands, evidence: { tier: "detail", expiresAtMs: v.evidence.expiresAtMs, missingRequirements: [...v.evidence.missingRequirements] },
    behavior: "notify_then_end", automaticDiagnosis: false, automaticIssue: false, replayAuthorized: false };
}
function taskForDelivery(input: { task?: MaintenanceTask; scope: NotificationScope; target: NotificationTarget;
  workId: string; expiresAtMs: number }, notice: BotIncidentNotice | BotTestNotice) {
  const task = input.task === undefined ? undefined : validateMaintenanceTask(input.task);
  if ((input.target.intent === "diagnose-or-report") !== (task !== undefined) || task && (notice.kind === "grokbox.ops.notification-test"
    || task.taskId !== input.workId || task.databaseId !== input.scope.databaseId || task.incidentId !== notice.incidentId
    || task.evidenceRevision !== notice.evidenceRevision || task.expiresAtMs !== input.expiresAtMs)) return fail();
  return task;
}
function envelopeNotice(notice: BotIncidentNotice | BotTestNotice, task: MaintenanceTask | undefined): NotificationEnvelope["notice"] {
  return task && notice.kind !== "grokbox.ops.notification-test"
    ? { ...notice, intent: "diagnose-or-report", behavior: "claim_analyze_report", automaticDiagnosis: true } : notice;
}
export function freezeNotification(input: { scope: NotificationScope; target: NotificationTarget; binding: NotificationBinding;
  workId: string; attemptId: string; createdAtMs: number; expiresAtMs: number; notice: BotIncidentNotice | BotTestNotice; task?: MaintenanceTask }) {
  const { workId, attemptId, createdAtMs, expiresAtMs } = input;
  const scope: NotificationScope = { databaseId: input.scope.databaseId, scopeId: input.scope.scopeId };
  const notice = input.notice.kind === "grokbox.ops.notification-test" ? testNotice(input.notice) : deliveryNotice(input.notice);
  const isTest = notice.kind === "grokbox.ops.notification-test";
  const target = validateNotificationTarget(input.target), binding = validateNotificationBinding(input.binding, target, scope, createdAtMs);
  if (!uuid(workId) || !uuid(attemptId) || !positive(expiresAtMs) || expiresAtMs <= createdAtMs
    || (isTest ? notice.testId !== workId || notice.createdAtMs > createdAtMs || notice.expiresAtMs !== expiresAtMs
      : !uuid(notice.incidentId) || !positive(notice.evidenceRevision)) || notice.behavior !== "notify_then_end"
    || notice.automaticDiagnosis !== false || notice.automaticIssue !== false || notice.replayAuthorized !== false) return fail();
  const bindingDigest = notificationBindingIdentity(binding), task = taskForDelivery(input, notice);
  const envelope: NotificationEnvelope = { schemaVersion: 1, kind: "grokbox.ops.notification", intent: task ? "diagnose-or-report" : "brief-notice", deliveryId: attemptId,
    workId, routeDecisionId: sha256Text(canonicalJson([workId, target, bindingDigest])), createdAtMs, expiresAtMs,
    target: { agentId: binding.agentId, routineId: binding.routineId, bindingId: binding.bindingId, bindingRevision: binding.revision },
    notice: envelopeNotice(notice, task), ...(task ? { task } : {}) };
  const serialized = canonicalJson(envelope), envelopeBytes = new TextEncoder().encode(serialized).length;
  if (envelopeBytes > NOTIFICATION_DELIVERY_POLICY.maxBytes) throw new NotificationError("payload_budget");
  const frozen: FrozenNotification = { schemaVersion: 1, scope, target, binding, bindingDigest, envelopeDigest: sha256Text(serialized),
    envelopeBytes, workId, attemptId, incidentId: isTest ? null : notice.incidentId, evidenceRevision: isTest ? null : notice.evidenceRevision, expiresAtMs, ...(task ? { task } : {}) };
  return { frozen, envelope, serialized };
}

/** Revalidate the exact bytes at the secret-bearing HTTP boundary. Reconstruct
 * every field rather than trusting a caller's JSON, hash, or extra properties.
 * No clock is refreshed and no historical observation becomes a new permit. */
export function validateNotificationBody(body: string, digest: string, binding: NotificationBinding, target: NotificationTarget, nowMs: number): NotificationEnvelope {
  if (typeof body !== "string" || new TextEncoder().encode(body).length > NOTIFICATION_DELIVERY_POLICY.maxBytes
    || !hash(digest) || sha256Text(body) !== digest || !positive(nowMs)) return fail();
  let value: NotificationEnvelope;
  try { value = JSON.parse(body); } catch { return fail(); }
  if (!value || value.schemaVersion !== 1 || value.kind !== "grokbox.ops.notification" || !["brief-notice", "diagnose-or-report"].includes(value.intent)
    || !uuid(value.deliveryId) || !uuid(value.workId) || !hash(value.routeDecisionId)
    || !positive(value.createdAtMs) || !positive(value.expiresAtMs) || value.createdAtMs > nowMs
    || value.expiresAtMs <= nowMs || value.expiresAtMs <= value.createdAtMs) return fail();
  validateNotificationBinding(binding, target, { databaseId: binding.databaseId, scopeId: binding.scopeId }, nowMs);
  const raw = value.intent === "diagnose-or-report" && value.notice?.kind === "grokbox.ops.notification"
    ? { ...value.notice, intent: "brief-notice" as const, behavior: "notify_then_end" as const, automaticDiagnosis: false as const } : value.notice;
  const notice = raw?.kind === "grokbox.ops.notification-test" ? testNotice(raw) : deliveryNotice(raw as BotIncidentNotice);
  const task = taskForDelivery({ task: value.task, scope: { databaseId: binding.databaseId, scopeId: binding.scopeId },
    target, workId: value.workId, expiresAtMs: value.expiresAtMs }, notice);
  if (notice.kind === "grokbox.ops.notification-test"
    ? notice.testId !== value.workId || notice.createdAtMs > value.createdAtMs || notice.expiresAtMs !== value.expiresAtMs
    : value.expiresAtMs > notice.evidence.expiresAtMs) return fail();
  const expected: NotificationEnvelope = { schemaVersion: 1, kind: "grokbox.ops.notification", intent: task ? "diagnose-or-report" : "brief-notice",
    deliveryId: value.deliveryId, workId: value.workId,
    routeDecisionId: sha256Text(canonicalJson([value.workId, target, notificationBindingIdentity(binding)])),
    createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs,
    target: { agentId: binding.agentId, routineId: binding.routineId, bindingId: binding.bindingId, bindingRevision: binding.revision },
    notice: envelopeNotice(notice, task), ...(task ? { task } : {}) };
  if (canonicalJson(expected) !== body) return fail();
  return expected;
}
