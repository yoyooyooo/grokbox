import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { freezeNotification, maintenanceTask, selectNotificationTarget, maintenanceReceiverPrincipal, projectNativeNotificationResult } from "@grokbox/runtime-kernel/observation";
import { openRuntimeStore, createPreparedNoticeDriver, openMonitorStore, activateOpsNotifications } from "@grokbox/box-runtime/runtime";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { noticeForWork } from "../../box-runtime/src/internal/io/incident-evidence.node.ts";
import { automaticFixture, MODEL } from "../../box-runtime/test/fixtures/automatic-notice.ts";
import { startManagementServer, type ManagementServer, type AccessGrant } from "../src/server.ts";

const I = "11111111-1111-4111-8111-111111111111", OWNER = "task-fixture-owner", RECEIVER = "task-fixture-receiver", OTHER = "task-fixture-other";
async function fixture() {
  const f = await automaticFixture(10, "diagnose-or-report"), servers: ManagementServer[] = [];
  const state = { grants: [
    { principalId: "owner", tokenSha256: sha256Text(OWNER), capabilities: [...CAPABILITIES] },
    { principalId: maintenanceReceiverPrincipal(f.pairing.bindingId), tokenSha256: sha256Text(RECEIVER), capabilities: ["notifications.tasks"] },
    { principalId: maintenanceReceiverPrincipal(randomUUID()), tokenSha256: sha256Text(OTHER), capabilities: ["notifications.tasks"] },
  ] as AccessGrant[] };
  let server: ManagementServer;
  async function start() {
    server = await startManagementServer({ store: openRuntimeStore(f.root, {}), installationId: I, observations: f.store, env: {},
      readGrants: async () => structuredClone(state.grants), native: { listBots: async () => { throw Error("no_catalog"); },
        ownershipRead: async () => { throw Error("no_collector"); }, readNotificationReceiver: f.readNative } },
      { hostHealth: { enabled: false }, notification: { request: f.request, idleMs: 50, blockedMs: 50 } });
    servers.push(server); return server;
  }
  async function api(path: string, input?: object, token = RECEIVER) {
    const response = await fetch(`${server.url}${path}`, { method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "x-grokbox-installation-id": I, ...(input ? { "content-type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() as { data?: any; error?: { code: string } } };
  }
  /** A deliberately fixed lower-boundary fixture: original OBS work and safe
   * notice, then an AH-188-shaped frozen task. This does not claim the unmerged
   * producer ran; separate producer/consumer integration remains required. */
  async function prepare() {
    const activated = await f.activate(); assert.equal(activated.state, "authorized");
    const record = (await f.owner.record("maintainer"))!, route = selectNotificationTarget(effectiveOps(f.document.ops), "diagnose-or-report");
    assert.equal(route.state, "selected"); if (route.state !== "selected") throw Error("route");
    const driver = createPreparedNoticeDriver({ durableRoot: f.root, expectedBindingRevision: record.revision,
      expectedModelRevision: MODEL, authorizationId: record.automatic!.id, readNative: f.readNative }, { request: f.request });
    const scope = await f.store.notificationScope(), workId = await f.emit();
    const binding = await driver.driver.inspect({ target: route.target, scope }); assert.ok(binding);
    const createdAtMs = Date.now();
    const db = await openMonitorSqlite(f.store.path, "write");
    try {
      const notice = await noticeForWork(db, workId), work = await db.first("SELECT * FROM notification_work WHERE id=?", [workId]); assert.ok(work);
      const task = maintenanceTask({ taskId: workId, databaseId: scope.databaseId, incidentId: notice.incidentId, evidenceRevision: notice.evidenceRevision,
        source: { episodeId: "e".repeat(64), eventId: randomUUID(), classification: "related-same-shape" }, expiresAtMs: Number(work.expires_at) });
      const fixed = freezeNotification({ target: route.target, binding, scope, notice, task, workId, attemptId: randomUUID(), createdAtMs, expiresAtMs: task.expiresAtMs });
      await db.run("INSERT INTO notification_attempts(id,work_id,target_id,binding_revision,state,reserved_at,receipt_json) VALUES(?,?,?,?,'reserved',?,?)",
        [fixed.frozen.attemptId, workId, binding.agentId, binding.revision, createdAtMs, canonicalJson({ schemaVersion: 1, frozen: fixed.frozen, result: null })]);
      const locator = `/v1/notification-tasks/${scope.databaseId}/${workId}`;
      const claim = { databaseId: scope.databaseId, workId, attemptId: fixed.frozen.attemptId, taskDigest: task.digest, requestId: randomUUID() };
      return { fixed, binding, driver, locator, claim, task, workId, scope };
    } finally { await db.close(); }
  }
  return { ...f, state, start, api, prepare, get server() { return server; },
    client: () => new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => OWNER }),
    close: async () => { for (const instance of servers.reverse()) await instance.close(); await f.close(); } };
}

test("analysis consent cannot be inherited from the old reminder enable action", async () => {
  const f = await fixture();
  try {
    await assert.rejects(activateOpsNotifications({ ...f.input, command: { ...f.command(), confirmAnalysis: undefined } }));
    assert.equal((await f.owner.record("maintainer"))!.automatic, undefined);
    assert.equal(f.requests.length, 0);
    const result = await f.activate(); assert.equal(result.state, "authorized");
    assert.equal((await f.owner.record("maintainer"))!.automatic!.analysisAuthorized, true);
  } finally { await f.close(); }
});

test("real isolated Webhook -> delegated task claim -> lost HTTP acknowledgment preserves independent facts and resumes the original report after restart", async () => {
  const f = await fixture();
  try {
    const p = await f.prepare(); await f.start();
    assert.equal((await f.api("/v1/notification-task-claims", p.claim)).status, 409, "reserved work cannot claim that it was dispatched");
    assert.equal((await f.store.beginNotification({ ...p.fixed.frozen, nowMs: Date.now() })).dispatch, true);
    let claimed: any, callbackError: unknown;
    f.reply(async response => {
      try {
        const reply = await f.api("/v1/notification-task-claims", p.claim);
        assert.equal(reply.status, 200, JSON.stringify(reply.body)); claimed = reply.body.data;
      } catch (error) { callbackError = error; }
      finally { response.destroy(); }
    });
    const outcome = projectNativeNotificationResult(await p.driver.driver.send({ binding: p.binding, body: p.fixed.serialized,
      envelopeDigest: p.fixed.frozen.envelopeDigest, signal: AbortSignal.timeout(10000) }));
    await f.store.settleNotification({ workId: p.workId, attemptId: p.fixed.frozen.attemptId, result: outcome, nowMs: Date.now() });
    assert.equal(callbackError, undefined); assert.ok(claimed);
    assert.equal(outcome.state, "unknown");
    assert.equal(f.requests.length, 1); assert.equal(JSON.parse(f.requests[0]!).intent, "diagnose-or-report");
    const stored = await f.store.notificationTask({ databaseId: p.scope.databaseId, workId: p.workId, principalId: maintenanceReceiverPrincipal(p.binding.bindingId) });
    assert.equal(stored.transport.state, "unknown"); assert.equal(stored.receipt!.source, "receiver-credential");
    assert.equal(stored.nativeTurnObserved, false); assert.equal(stored.userDisplay, "not_observed");
    assert.equal((await f.api("/v1/notification-task-claims", p.claim)).body.data.receipt.claim.claimId, claimed.receipt.claim.claimId);
    const view = (await f.client().notification(`notification:${I}:${p.scope.databaseId}:${p.workId}`)).data;
    assert.equal(view.attempt!.state, "unknown"); assert.equal(view.taskReceipt!.claim.claimId, claimed.receipt.claim.claimId);
    assert.equal(view.retry!.reason, "receiver_reported"); assert.equal(view.botReport, "not_observed");
    await f.server.close(); await f.start();
    const readback = await f.api(p.locator);
    assert.equal(readback.status, 200, JSON.stringify(readback.body));
    assert.equal(readback.body.data.receipt.claim.claimId, claimed.receipt.claim.claimId);
    assert.equal(readback.body.data.transport.state, "unknown");
    const result = { ...p.claim, requestId: randomUUID(), claimId: claimed.receipt.claim.claimId, conclusion: "repair-proposed", reportDigest: "f".repeat(64) };
    const reported = await f.api("/v1/notification-task-results", result); assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.data.transport.state, "unknown"); assert.equal(reported.body.data.receipt.result.conclusion, "repair-proposed");
    assert.equal(reported.body.data.task.adoptionAuthority, false); assert.equal(reported.body.data.task.mutationAuthority, false);
    assert.deepEqual((await f.api("/v1/notification-task-results", result)).body.data, reported.body.data);
    assert.equal((await f.api("/v1/notification-task-results", { ...result, reportDigest: "a".repeat(64) })).status, 409);
    const reopened = await openMonitorStore(f.root).notificationTask({ databaseId: p.scope.databaseId, workId: p.workId, principalId: maintenanceReceiverPrincipal(p.binding.bindingId) });
    assert.equal(reopened.receipt!.result!.requestId, result.requestId); assert.equal(reopened.transport.state, "unknown");
    assert.equal(f.requests.length, 1, "neither report reconciliation nor restart sends another Webhook");
  } finally { await f.close(); }
});

test("task writes require the actual delegated principal, current binding and exact claim; extra authority and content are rejected", async () => {
  const f = await fixture();
  try {
    const p = await f.prepare(); await f.start();
    await f.store.beginNotification({ ...p.fixed.frozen, nowMs: Date.now() });
    assert.equal((await f.api(p.locator, undefined, OTHER)).status, 403);
    assert.equal((await f.api("/v1/notification-task-claims", p.claim, OWNER)).status, 403);
    assert.equal((await f.api("/v1/notification-task-claims", { ...p.claim, principalId: maintenanceReceiverPrincipal(p.binding.bindingId) })).status, 400);
    assert.equal((await f.api("/v1/notification-task-claims", { ...p.claim, mutationAuthority: true })).status, 400);
    assert.equal((await f.api("/v1/notification-task-claims", { ...p.claim, taskDigest: "0".repeat(64) })).status, 409);
    assert.equal((await f.api(`${p.locator}/evidence`)).status, 409, "a receiver cannot fetch evidence before its original claim");
    const claimed = await f.api("/v1/notification-task-claims", p.claim); assert.equal(claimed.status, 200);
    const evidence = await f.api(`${p.locator}/evidence`); assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    assert.equal(evidence.body.data.view, "public-summary");
    assert.equal(JSON.stringify(evidence.body).includes("PRIVATE_INPUT"), false);
    assert.equal(JSON.stringify(evidence.body).includes("local-diagnostic"), false);
    assert.equal((await f.api("/v1/notification-task-claims", { ...p.claim, requestId: randomUUID() })).status, 409);
    const result = { ...p.claim, requestId: randomUUID(), claimId: claimed.body.data.receipt.claim.claimId, conclusion: "blocked", reportDigest: null };
    assert.equal((await f.api("/v1/notification-task-results", { ...result, claimId: randomUUID() })).status, 409);
    assert.equal((await f.api("/v1/notification-task-results", { ...result, report: "PRIVATE_SOURCE" })).status, 400);
    assert.equal((await f.api("/v1/notification-task-results", { ...result, conclusion: "repaired" })).status, 400);
    stateRevoke(f);
    assert.equal((await f.api("/v1/notification-task-results", result)).status, 401);
    const stored = await f.store.notificationDelivery(p.workId);
    assert.equal(stored.taskReceipt!.result, null); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
function stateRevoke(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.grants = f.state.grants.filter(grant => grant.tokenSha256 !== sha256Text(RECEIVER));
}
