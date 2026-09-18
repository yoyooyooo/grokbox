import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultConfig, effectiveOps, validateConfig } from "../src/config.ts";
import { BOT_NOTICE_SUMMARIES, selectNotificationTarget, validateNotificationBinding, freezeNotification,
  notificationBindingIdentity, type BotIncidentNotice, type NotificationBinding, type NotificationTarget } from "../src/observation.ts";

const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", NOW = Date.now();
const route = (ops: object) => selectNotificationTarget(effectiveOps(validateConfig({ ...defaultConfig(), ops }).ops));
const base = { targets: { default: { agentId: AGENT, routineKey: "ops-notice" } } };
function fixture() {
  const selected = route(base); if (selected.state !== "selected") throw Error("fixture_target_missing");
  const target = selected.target, scope = { databaseId: randomUUID(), scopeId: "a".repeat(64) };
  const binding: NotificationBinding = { ...scope, bindingId: randomUUID(), revision: 1, targetAlias: "default", agentId: AGENT,
    routineKey: "ops-notice", routineId: "notice", routineRevision: "b".repeat(64), modelRevision: "c".repeat(64),
    qualificationRevision: "d".repeat(64), policyRevision: target.policyRevision, dataPolicy: "safe-summary", receiverMode: "notify_then_end",
    observedAtMs: NOW, validUntilMs: NOW + 5000 };
  const incidentId = randomUUID();
  const notice: BotIncidentNotice = { schemaVersion: 1, kind: "grokbox.ops.notification", intent: "brief-notice", incidentId,
    evidenceRevision: 1, capturedAtMs: NOW, summary: BOT_NOTICE_SUMMARIES.execution_failure!, classification: "unknown", rootCause: "not_proven",
    commands: [{ commandId: "monitor-incident-v1", argv: ["grokbox", "runtime", "monitor", "incident", incidentId, "--evidence-revision", "1", "--json"], requires: "box-local", readOnly: true }],
    evidence: { tier: "detail", expiresAtMs: NOW + 60000, missingRequirements: ["E01", "E04"] }, behavior: "notify_then_end", automaticDiagnosis: false, automaticIssue: false, replayAuthorized: false };
  return { scope, target, binding, notice, workId: randomUUID(), attemptId: randomUUID(), createdAtMs: NOW, expiresAtMs: NOW + 60000 };
}

test("default routing uses exactly one configured target even when advanced routing is off", () => {
  expect(route(base)).toMatchObject({ state: "selected", target: { alias: "default", agentId: AGENT, routineKey: "ops-notice", installationLimit: 2, targetLimit: 2 } });
  expect(route({})).toMatchObject({ state: "blocked", reason: "target_unconfigured" });
  expect(route({ ...base, routing: { enabled: true } })).toMatchObject({ state: "blocked", reason: "routing_unsupported" });
  expect(route({ ...base, notifications: { allowDuplicateDelivery: true } })).toMatchObject({ state: "blocked", reason: "mode_unsupported" });
});

test("disabled and data/intent-incompatible targets are never guessed or upgraded", () => {
  for (const [patch, reason] of [
    [{ enabled: false }, "target_disabled"], [{ allowedIntents: ["diagnose-or-report"] }, "intent_not_allowed"],
    [{ dataPolicy: "diagnostic-summary" }, "data_policy_unsupported"],
  ] as const) expect(route({ targets: { default: { agentId: AGENT, routineKey: "ops-notice", ...patch } } })).toMatchObject({ state: "blocked", reason });
  expect(route({ ...base, notifications: { mode: "off" } })).toMatchObject({ state: "blocked", reason: "notifications_off" });
});

test("binding is scoped to installation, receiver, model, routine and local policy with finite source freshness", () => {
  const f = fixture(); expect(validateNotificationBinding(f.binding, f.target, f.scope, NOW)).toEqual(f.binding);
  for (const patch of [{ scopeId: "0".repeat(64) }, { databaseId: randomUUID() }, { agentId: randomUUID() },
    { targetAlias: "other" }, { routineKey: "other" }, { policyRevision: "0".repeat(64) }, { modelRevision: "unproven" },
    { receiverMode: "diagnose" }, { validUntilMs: NOW }, { observedAtMs: NOW + 1 }, { validUntilMs: NOW + 6000 }]) {
    expect(() => validateNotificationBinding({ ...f.binding, ...patch } as NotificationBinding, f.target, f.scope, NOW)).toThrow();
  }
  const refreshed = { ...f.binding, observedAtMs: NOW + 1000, validUntilMs: NOW + 6000 };
  expect(notificationBindingIdentity(refreshed)).toBe(notificationBindingIdentity(f.binding));
  expect(notificationBindingIdentity({ ...refreshed, modelRevision: "1".repeat(64) })).not.toBe(notificationBindingIdentity(f.binding));
});

test("frozen actual payload reprojects fields and refuses free-text commands or summaries", () => {
  const f = fixture(), safe = freezeNotification(f);
  expect(safe.frozen.envelopeBytes).toBeLessThanOrEqual(8192);
  const extended = { ...f, notice: { ...f.notice, rawPrompt: "PRIVATE", evidence: { ...f.notice.evidence, blobPath: "/PRIVATE" } },
    scope: { ...f.scope, path: "/PRIVATE" }, binding: { ...f.binding, token: "PRIVATE", endpoint: "PRIVATE" } };
  expect(freezeNotification(extended)).toEqual(safe);
  expect(safe.serialized).not.toContain("PRIVATE");
  expect(() => freezeNotification({ ...f, notice: { ...f.notice, summary: "PRIVATE" } })).toThrow();
  expect(() => freezeNotification({ ...f, notice: { ...f.notice, commands: [{ ...f.notice.commands[0]!, argv: ["rm", "-rf", "/PRIVATE"] }] } })).toThrow();
  expect(() => freezeNotification({ ...f, notice: { ...f.notice, evidence: { ...f.notice.evidence, missingRequirements: ["PRIVATE"] } } })).toThrow();
});
