import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultConfig, effectiveOps, validateConfig } from "../src/config.ts";
import { canonicalJson, sha256Text } from "../src/hash.ts";
import { maintenanceSource, maintenanceTask, validateMaintenanceTask, validateMaintenanceReceipt } from "../src/notification-tasks.ts";
import { selectNotificationTarget, pairingTarget, freezeNotification, validateNotificationBody, receiverBlueprint,
  RECEIVER_ANALYSIS_POLICY_REVISION, validateNoticeAuthorization, validateNoticeActivation,
  BOT_NOTICE_SUMMARIES, type NotificationBinding, type BotIncidentNotice } from "../src/observation.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now = Date.now();
const configured = (extra = {}) => effectiveOps(validateConfig({ ...defaultConfig(), ops: {
  notifications: { mode: "off" }, maintainer: { enabled: true, target: "maintainer" }, diagnostics: { mode: "automatic-bounded" },
  routing: { defaultTarget: "maintainer" },
  targets: { maintainer: { agentId: A, routineKey: "analysis", allowedIntents: ["diagnose-or-report"] } }, ...extra } }).ops);
const change = (classification = "related-same-shape", patch = {}) => ({ value: { name: "host_patch_health", eventId: randomUUID(), sourceState: "stable",
  sourceChange: { version: 1, episodeId: "e".repeat(64), classification, executionAuthority: false, userImpact: "not-established", ...patch } } });

test("producer contract consumption is bounded to its decision; snapshots, no-intersection and old evidence never wake analysis", () => {
  expect(maintenanceSource([])).toEqual({ state: "not_applicable" });
  expect(maintenanceSource([{ value: { name: "host_patch_health", analysis: "violated", sourceSha: "f".repeat(64) } }])).toEqual({ state: "not_applicable" });
  expect(maintenanceSource([change("no-intersection")])).toEqual({ state: "quiet" });
  const snapshot = change(); snapshot.value.sourceState = "snapshot";
  expect(maintenanceSource([snapshot])).toEqual({ state: "quiet" });
  for (const classification of ["related-same-shape", "structural-change", "unknown"]) {
    const event = change(classification, { before: { privatePath: "/PRIVATE" }, reason: "PRIVATE" });
    const result = maintenanceSource([event]);
    expect(result).toMatchObject({ state: "ready", source: { classification, episodeId: "e".repeat(64), eventId: event.value.eventId } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
  for (const patch of [{ executionAuthority: true }, { version: 2 }, { episodeId: "bad" }, { userImpact: "safe" }])
    expect(maintenanceSource([change("unknown", patch)])).toEqual({ state: "unavailable" });
  expect(maintenanceSource([change(), change("structural-change")])).toEqual({ state: "unavailable" });
  expect(maintenanceSource([change(), change("unknown", { episodeId: "f".repeat(64) })])).toEqual({ state: "unavailable" });
});

test("maintainer delivery and permission are separate from user notices and presets", () => {
  for (const preset of ["user", "maintainer"])
    expect(selectNotificationTarget(effectiveOps({ preset }), "diagnose-or-report")).toMatchObject({ state: "blocked" });
  expect(selectNotificationTarget(configured())).toEqual({ state: "blocked", reason: "notifications_off" });
  const route = selectNotificationTarget(configured(), "diagnose-or-report");
  expect(route).toMatchObject({ state: "selected", target: { alias: "maintainer", intent: "diagnose-or-report", agentId: A } });
  if (route.state !== "selected") throw Error("fixture");
  expect(pairingTarget(configured(), "maintainer")).toEqual(route.target);
  expect(selectNotificationTarget(configured({ diagnostics: { mode: "on-request" } }), "diagnose-or-report")).toMatchObject({ reason: "intent_not_allowed" });
  expect(selectNotificationTarget(configured({ maintainer: { enabled: false } }), "diagnose-or-report")).toMatchObject({ state: "blocked" });
  const blueprint = receiverBlueprint("analysis", "diagnose-or-report");
  expect(sha256Text(blueprint.prompt)).toBe(RECEIVER_ANALYSIS_POLICY_REVISION);
  expect(blueprint.isEnabled).toBe(false);
  const command = { alias: "maintainer", expectedBindingRevision: 1, expectedModelRevision: "a".repeat(64), operationId: "enable", confirmed: true, confirmAnalysis: true as const };
  expect(validateNoticeActivation(command).confirmAnalysis).toBe(true);
  expect(() => validateNoticeActivation({ ...command, confirmAnalysis: false } as never)).toThrow();
  const authorization = { version: 2, consent: "explicit-enable", id: randomUUID(), operationId: "enable", requestDigest: "a".repeat(64), bindingRevision: 2,
    activatedAtMs: now, modelRevision: "b".repeat(64), qualificationRevision: "c".repeat(64), nativeTurnObserved: false, includesExistingWork: false };
  expect(validateNoticeAuthorization(authorization).analysisAuthorized).toBeUndefined();
  expect(validateNoticeAuthorization({ ...authorization, analysisAuthorized: true }).analysisAuthorized).toBe(true);
  expect(() => validateNoticeAuthorization({ ...authorization, analysisAuthorized: "preset" })).toThrow();
});

test("analysis envelope freezes one task with no mutation authority, and the private HTTP boundary rejects authority or prompt injection", () => {
  const route = selectNotificationTarget(configured(), "diagnose-or-report"); if (route.state !== "selected") throw Error("fixture");
  const target = route.target, scope = { databaseId: randomUUID(), scopeId: "a".repeat(64) }, workId = randomUUID(), incidentId = randomUUID();
  const binding: NotificationBinding = { ...scope, bindingId: randomUUID(), revision: 2, targetAlias: "maintainer", agentId: A,
    routineKey: "analysis", routineId: "analysis", routineRevision: "b".repeat(64), modelRevision: "c".repeat(64), qualificationRevision: "d".repeat(64),
    policyRevision: target.policyRevision, dataPolicy: "safe-summary", receiverMode: "claim_analyze_report", observedAtMs: now, validUntilMs: now + 5000 };
  const task = maintenanceTask({ databaseId: scope.databaseId, taskId: workId, incidentId, evidenceRevision: 1, expiresAtMs: now + 60000,
    source: { episodeId: "e".repeat(64), eventId: randomUUID(), classification: "related-same-shape" } });
  const notice: BotIncidentNotice = { schemaVersion: 1, kind: "grokbox.ops.notification", intent: "brief-notice", incidentId, evidenceRevision: 1, capturedAtMs: now,
    summary: BOT_NOTICE_SUMMARIES.execution_failure!, classification: "unknown", rootCause: "not_proven", behavior: "notify_then_end", automaticDiagnosis: false,
    automaticIssue: false, replayAuthorized: false, evidence: { tier: "detail", expiresAtMs: now + 60000, missingRequirements: ["E01"] },
    commands: [{ commandId: "monitor-incident-v1", argv: ["grokbox", "runtime", "monitor", "incident", incidentId, "--evidence-revision", "1", "--json"], requires: "box-local", readOnly: true }] };
  const frozen = freezeNotification({ scope, target, binding, task, notice, workId, attemptId: randomUUID(), createdAtMs: now, expiresAtMs: now + 60000 });
  expect(frozen.envelope).toMatchObject({ intent: "diagnose-or-report", notice: { behavior: "claim_analyze_report", automaticDiagnosis: true }, task: { mutationAuthority: false, adoptionAuthority: false } });
  expect(validateNotificationBody(frozen.serialized, frozen.frozen.envelopeDigest, binding, target, now)).toEqual(frozen.envelope);
  for (const patch of [{ mutationAuthority: true }, { adoptionAuthority: true }, { endpoint: "https://private.example.test" }, { taskId: randomUUID() }]) {
    expect(() => validateMaintenanceTask({ ...task, ...patch } as never)).toThrow();
    const body = canonicalJson({ ...frozen.envelope, task: { ...task, ...patch } });
    expect(() => validateNotificationBody(body, sha256Text(body), binding, target, now)).toThrow();
  }
  const body = canonicalJson({ ...frozen.envelope, notice: { ...frozen.envelope.notice, behavior: "notify_then_end" } });
  expect(() => validateNotificationBody(body, sha256Text(body), binding, target, now)).toThrow();
  const receipt = { source: "receiver-credential", nativeTurnObserved: false, claim: { requestId: randomUUID(), claimId: randomUUID(), principalId: `notification-receiver:${binding.bindingId}`,
    claimedAtMs: now + 1, taskDigest: task.digest }, result: null } as const;
  expect(validateMaintenanceReceipt(receipt as never, task)).toEqual(receipt);
  for (const patch of [{ nativeTurnObserved: true }, { userRead: true }, { source: "native-bot" }])
    expect(() => validateMaintenanceReceipt({ ...receipt, ...patch } as never, task)).toThrow();
});
