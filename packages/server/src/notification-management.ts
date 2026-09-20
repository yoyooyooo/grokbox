import { createHash } from "node:crypto";
import { Effect } from "effect";
import { ManagementClientError, UUID, notificationIdentity, normalizeReceiverChange, type ReceiverView, type ReceiverList,
  type ReceiverOperation, type ReceiverVerification, type ReceiverChangeRequest, type NotificationView, type NotificationList, type NotificationTestOperation } from "@grokbox/client/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ConfigError, effectiveOps } from "@grokbox/runtime-kernel/config";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { NotificationError, OpsPairingError, selectNotificationTarget, type PairingRecord, type ReceiverManagementReceipt } from "@grokbox/runtime-kernel/observation";
import { activateOpsNotifications, openOpsBindings, openMonitorStore, openConfigStore, rootConfigLayout, readStorageConfiguration,
  createPreparedNoticeDriver, runOpsNotificationDelivery, type ExplicitReceiverReader, type startOpsNotificationWorker } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { pageInput } from "./pagination.ts";

export type NotificationDomain = { root: string; installationId: string; readNative: ExplicitReceiverReader;
  request?: NonNullable<Parameters<typeof startOpsNotificationWorker>[1]>["request"] };
const refuse = (code: "not_found" | "revision_conflict" | "source_changed" | "idempotency_conflict" | "source_unavailable", message: string): never => {
  throw new HttpFailure(code === "not_found" ? 404 : code === "source_unavailable" ? 503 : 409, code, message);
};
function projectError(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof ConfigError) return new HttpFailure(503, "source_unavailable", "The notification configuration is unavailable.");
  const reason = error instanceof NotificationError || error instanceof OpsPairingError ? error.reason : error instanceof BoxRuntimeError ? error.message : null;
  if (reason && ["capacity", "receipt_capacity", "notification_test_capacity"].includes(reason)) return new HttpFailure(507, "store_full", "The notification recovery capacity is full; previous records have not been removed.");
  if (reason && ["authorization_conflict", "notification_test_conflict"].includes(reason)) return new HttpFailure(409, "idempotency_conflict", "The request ID already belongs to another receiver action.");
  if (reason && ["binding_revision_changed", "binding_identity_changed", "operation_conflict"].includes(reason)) return new HttpFailure(409, "revision_conflict", "The binding changed; refresh its revision without discarding the draft.");
  if (reason === "notification_scope_changed") return new HttpFailure(409, "source_changed", "The notification database changed; do not repeat an old action into its replacement.");
  if (reason === "notification_cursor_gap") return new HttpFailure(409, "cursor_gap", "The retained notification cursor is no longer in this database.");
  if (reason && ["activation_outcome_unknown", "monitor_commit_unknown"].includes(reason)) return new HttpFailure(409, "operation_unknown", "The notification action is uncertain. Read the original operation; do not repeat it.");
  if (reason === "automatic_confirmation_required" || reason === "invalid_automatic_authorization") return new HttpFailure(400, "invalid_input", "Explicit notification consent and a reviewed target revision are required.");
  return new HttpFailure(503, "source_unavailable", "The notification source or receiver qualification is unavailable. No alternative target was selected.");
}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: projectError });
/** Shutdown aborts transport and awaits the actual operation, including final
 * durable settlement. Interrupting a Promise does not prove its work stopped. */
const owned = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.scoped(Effect.gen(function* () {
  const task = yield* Effect.acquireRelease(Effect.sync(() => {
    const controller = new AbortController(), promise = run(controller.signal); void promise.catch(() => undefined);
    return { controller, promise };
  }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
  return yield* io(() => task.promise);
}));
export function notificationOperationKey(installationId: string, principalId: string, databaseId: string, requestId: string, domain: "receiver" | "test") {
  return sha256Text(canonicalJson(["notification-management-v1", installationId, principalId, databaseId, requestId, domain]));
}
function testWorkId(key: string): string {
  const bytes = createHash("sha256").update(`notification-test:${key}`).digest(); bytes[6] = (bytes[6]! & 15) | 0x80; bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function receiverView(installationId: string, row: PairingRecord): ReceiverView {
  return { receiverRef: `receiver:${installationId}:${row.plan.scope.databaseId}:${row.bindingId}`, bindingId: row.bindingId,
    databaseId: row.plan.scope.databaseId, alias: row.plan.target.alias, botRef: `bot:${installationId}:${row.plan.target.agentId}`, routineId: row.plan.routineId,
    revision: row.revision, state: row.state, credentialStored: row.credentialPresent, updatedAtMs: row.updatedAtMs,
    automatic: row.automatic ? { authorizationId: row.automatic.id, activatedAtMs: row.automatic.activatedAtMs, modelRevision: row.automatic.modelRevision } : null,
    currentEligibility: "not-checked", testRequired: false, nativeTurnObserved: false };
}
function operationView(installationId: string, databaseId: string, requestId: string, row: ReceiverManagementReceipt): ReceiverOperation {
  return { version: 1, operationRef: `receiver-operation:${installationId}:${databaseId}:${row.operationId}`, requestId,
    receiverRef: `receiver:${installationId}:${databaseId}:${row.bindingId}`, action: row.action, beforeRevision: row.beforeRevision, appliedRevision: row.appliedRevision,
    appliedAtMs: row.appliedAtMs, authorizationId: row.authorizationId, state: "succeeded", notificationSent: false, testRequired: false };
}
async function findReceiver(domain: NotificationDomain, ref: string) {
  const target = notificationIdentity(ref, domain.installationId), rows = await openOpsBindings(domain.root).records();
  const row = rows.find(row => row.bindingId === target.id);
  if (!row) return refuse("not_found", "This local receiver binding was not found.");
  if (row.plan.scope.databaseId !== target.databaseId) return refuse("source_changed", "The receiver belongs to another notification database.");
  return row;
}
async function deliveryView(domain: NotificationDomain, databaseId: string, workId: string): Promise<NotificationView> {
  const row = await openMonitorStore(domain.root).notificationDelivery(workId, databaseId);
  if (row.workId === undefined || row.createdAtMs === undefined || row.expiresAtMs === undefined || row.evidenceRevision === undefined)
    return refuse("not_found", "This notification work was not found; absence does not authorize a repeat attempt.");
  const attempt = row.attempt;
  return { notificationRef: `notification:${domain.installationId}:${databaseId}:${workId}`, databaseId, workId,
    purpose: row.purpose as "test" | "incident", incidentRef: row.incidentId === null ? null : `incident:${domain.installationId}:${databaseId}:${row.incidentId}`,
    evidenceRevision: row.evidenceRevision, state: row.state as NotificationView["state"], createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs,
    attempt: attempt ? { attemptId: attempt.attemptId, state: attempt.state as NonNullable<NotificationView["attempt"]>["state"],
      targetAgentId: attempt.targetAgentId, bindingRevision: attempt.bindingRevision, envelopeDigest: attempt.envelopeDigest, envelopeBytes: attempt.envelopeBytes,
      reservedAtMs: attempt.reservedAtMs, settledAtMs: attempt.settledAtMs } : null,
    automaticRetry: false, botReport: "not_observed", userRead: "not_observed" };
}
async function testOperation(domain: NotificationDomain, principalId: string, databaseId: string, requestId: string): Promise<NotificationTestOperation> {
  const key = notificationOperationKey(domain.installationId, principalId, databaseId, requestId, "test"), workId = testWorkId(key);
  const row = await openMonitorStore(domain.root).notificationTest(databaseId, workId);
  if (!row || row.operationId !== key) return refuse("not_found", "No test receipt is recorded for this principal and original request.");
  const delivery = await deliveryView(domain, databaseId, workId);
  return { version: 1, operationRef: `notification-test-operation:${domain.installationId}:${databaseId}:${key}`, requestId,
    receiverRef: `receiver:${domain.installationId}:${databaseId}:${row.bindingId}`, action: "test", expectedRevision: row.bindingRevision,
    state: delivery.state === "completed" ? "succeeded" : ["blocked", "expired"].includes(delivery.state) ? "refused" : "unknown", delivery, enablesAutomatic: false };
}
async function verify(domain: NotificationDomain, row: PairingRecord, signal: AbortSignal): Promise<ReceiverVerification> {
  const ref = receiverView(domain.installationId, row).receiverRef;
  const blocked = (reason: string): ReceiverVerification => ({ receiverRef: ref, revision: row.revision, state: "blocked", reason,
    modelRevision: null, testRequired: false, notificationSent: false, grantsPermission: false });
  if (!["prepared", "disabled"].includes(row.state) || !row.credentialPresent) return blocked("binding_not_prepared");
  const configured = await openConfigStore(rootConfigLayout(domain.root)).read(), route = selectNotificationTarget(effectiveOps(configured.document.ops));
  if (route.state !== "selected" || route.target.alias !== row.plan.target.alias) return blocked("target_policy_blocked");
  const scope = await openMonitorStore(domain.root).notificationScope();
  const native = await domain.readNative(row.plan.target.agentId, row.plan.routineId, signal);
  const modelRevision = native.model?.modelRevision;
  if (!modelRevision) return blocked("model_not_observed");
  const driver = createPreparedNoticeDriver({ durableRoot: domain.root, expectedBindingRevision: row.revision, expectedModelRevision: modelRevision,
    readNative: async () => native, signal, allowDisabled: true });
  const binding = await driver.driver.inspect({ target: route.target, scope, signal });
  if (!binding) return blocked(driver.blocker() ?? "receiver_not_qualified");
  return { receiverRef: ref, revision: row.revision, state: "ready", reason: "fresh-preflight-only", modelRevision: binding.modelRevision,
    testRequired: false, notificationSent: false, grantsPermission: false };
}

export function notificationManagement(domain: NotificationDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const path = url.pathname;
    yield* Effect.try({ try: () => {
      requireCapability(principal, method === "POST" ? path === "/v1/notification-tests" ? "notifications.test" : "notifications.write"
        : path.includes("-operations/") ? "operations.read" : "notifications.read");
      if (path !== "/v1/notifications" && url.search) throw new HttpFailure(400, "invalid_input", "This notification endpoint does not accept query parameters.");
    }, catch: projectError });
    if (method === "GET" && path === "/v1/notification-receivers") return yield* io(async () => ({ receivers: (await openOpsBindings(domain.root).records()).map(row => receiverView(domain.installationId, row)), coverage: "local-bindings", maxReceivers: 8 } satisfies ReceiverList));
    const receiver = /^\/v1\/notification-receivers\/([^/]+)(\/verification)?$/.exec(path);
    if (method === "GET" && receiver) return yield* io(async signal => {
      const row = await findReceiver(domain, decodeURIComponent(receiver[1]!));
      return receiver[2] ? verify(domain, row, signal) : receiverView(domain.installationId, row);
    }).pipe(Effect.timeout("20 seconds"));
    const lookup = /^\/v1\/notification-(receiver|test)-operations\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "GET" && lookup) return yield* io(async () => {
      if (!UUID.test(lookup[2]!) || !UUID.test(lookup[3]!)) throw new HttpFailure(400, "invalid_input", "Invalid notification operation locator.");
      const databaseId = lookup[2]!.toLowerCase(), requestId = lookup[3]!.toLowerCase();
      if (lookup[1] === "test") return testOperation(domain, principal.id, databaseId, requestId);
      const key = notificationOperationKey(domain.installationId, principal.id, databaseId, requestId, "receiver");
      const receipt = await openOpsBindings(domain.root).managementReceipt(key);
      if (!receipt) return refuse("not_found", "No receiver receipt is recorded for this principal and request.");
      return operationView(domain.installationId, databaseId, requestId, receipt);
    });
    if (method === "GET" && path === "/v1/notifications") return yield* io(async () => {
      const page = pageInput(url), store = openMonitorStore(domain.root), listed = await store.notificationPage(page.cursor ?? undefined, page.limit);
      const notifications: NotificationView[] = [];
      for (const id of listed.ids) notifications.push(await deliveryView(domain, listed.databaseId, id));
      return { notifications, databaseId: listed.databaseId, nextCursor: listed.nextCursor, coverage: "retained-work" } satisfies NotificationList;
    });
    const delivery = /^\/v1\/notifications\/([^/]+)$/.exec(path);
    if (method === "GET" && delivery) return yield* io(async () => {
      const target = notificationIdentity(decodeURIComponent(delivery[1]!), domain.installationId, "notification");
      return deliveryView(domain, target.databaseId, target.id);
    });
    if (method === "POST" && ["/v1/notification-receiver-changes", "/v1/notification-tests"].includes(path)) {
      const request = yield* Effect.try({ try: () => normalizeReceiverChange(input, domain.installationId), catch: projectError });
      if ((request.action === "test") !== (path === "/v1/notification-tests")) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Use the dedicated endpoint and capability for an independent notification test."));
      return yield* owned(async signal => {
        const { databaseId, id } = notificationIdentity(request.receiverRef, domain.installationId), isTest = request.action === "test";
        const key = notificationOperationKey(domain.installationId, principal.id, databaseId, request.requestId, isTest ? "test" : "receiver");
        const requestDigest = sha256Text(canonicalJson(request)), bindings = openOpsBindings(domain.root), store = openMonitorStore(domain.root);
        const previous = isTest ? await store.notificationTest(databaseId, testWorkId(key)) : await bindings.managementReceipt(key);
        if (previous) {
          if (previous.requestDigest !== requestDigest) return refuse("idempotency_conflict", "The request ID belongs to different notification input.");
          return isTest ? testOperation(domain, principal.id, databaseId, request.requestId) : operationView(domain.installationId, databaseId, request.requestId, previous as ReceiverManagementReceipt);
        }
        const row = await findReceiver(domain, request.receiverRef);
        if (row.revision !== request.expectedRevision) return refuse("revision_conflict", "The receiver revision changed. Review the current target before another submission.");
        if (request.action === "enable") {
          const result = await activateOpsNotifications({ durableRoot: domain.root, command: { alias: row.plan.target.alias, expectedBindingRevision: request.expectedRevision,
            expectedModelRevision: request.expectedModelRevision, operationId: key, confirmed: true }, expectedBindingId: id, requestDigest, readNative: domain.readNative, signal });
          return operationView(domain.installationId, databaseId, request.requestId, result.receipt);
        }
        if (request.action === "disable" || request.action === "unbind") {
          try { await bindings.revoke(row.plan.target.alias, request.expectedRevision, request.action, true, { operationId: key, requestDigest, bindingId: id }); }
          catch (error) { if (error instanceof OpsPairingError && error.reason === "store_unavailable") throw new HttpFailure(409, "operation_unknown", "The local receiver change may have committed. Read its original receipt."); throw error; }
          const receipt = await bindings.managementReceipt(key).catch(() => { throw new HttpFailure(409, "operation_unknown", "The receiver change may have committed; its receipt is not readable yet."); });
          if (!receipt) throw new HttpFailure(409, "operation_unknown", "The receiver receipt is not readable yet.");
          return operationView(domain.installationId, databaseId, request.requestId, receipt);
        }
        const test = request as Extract<ReceiverChangeRequest, { action: "enable" | "test" }>;
        const preflight = await verify(domain, row, signal);
        if (preflight.state !== "ready" || preflight.modelRevision !== test.expectedModelRevision || row.state !== "prepared") return refuse("source_unavailable", "The test receiver did not pass its independent fresh preflight.");
        signal.throwIfAborted();
        const storage = await readStorageConfiguration(domain.root), writes = openMonitorStore(domain.root, storage.monitor), workId = testWorkId(key);
        const created = await writes.createNotificationTest({ databaseId, workId, operationId: key, requestDigest, alias: row.plan.target.alias,
          bindingId: id, bindingRevision: row.revision, modelRevision: test.expectedModelRevision, nowMs: Date.now() });
        try {
          if (created.created) {
            const driver = createPreparedNoticeDriver({ durableRoot: domain.root, expectedBindingRevision: row.revision, expectedModelRevision: test.expectedModelRevision,
              readNative: domain.readNative, signal }, { request: domain.request });
            const result = await runOpsNotificationDelivery({ durableRoot: domain.root, workId, driver: driver.driver, signal });
            if (result.state === "blocked") await writes.settleNotificationTestWithoutAttempt(workId);
          }
          return await testOperation(domain, principal.id, databaseId, request.requestId);
        } catch {
          throw new HttpFailure(409, "operation_unknown", "The test has a durable identity but its final result could not be verified. Query the original test operation without sending again.");
        }
      });
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The notification endpoint is not supported."));
  });
}
