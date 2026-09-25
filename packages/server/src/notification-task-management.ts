import { UUID } from "@grokbox/client/contract";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { selectNotificationTarget, type FrozenNotification, type MaintenanceResult } from "@grokbox/runtime-kernel/observation";
import { openConfigStore, rootConfigLayout, openMonitorStore, openOpsBindings, readStorageConfiguration } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import type { NotificationDomain } from "./notification-management.ts";

/** An installed, delegated receiver credential can attest its exact task. This
 * is not native-turn evidence and no request-supplied Bot ID grants authority. */
export async function notificationTaskManagement(domain: NotificationDomain, principal: Principal, method: string, url: URL,
  value: unknown, signal: AbortSignal) {
  requireCapability(principal, "notifications.tasks");
  if (url.search || !/^notification-receiver:[a-f0-9-]{36}$/.test(principal.id))
    throw new HttpFailure(403, "permission_denied", "An exact delegated notification receiver principal is required.");
  const observed = openMonitorStore(domain.root);
  const authorize = async (frozen: FrozenNotification) => {
    if (!domain.authorizeTasks) throw new HttpFailure(503, "source_unavailable", "The task authorization owner is unavailable.");
    await domain.authorizeTasks(signal);
    const [config, receiver] = await Promise.all([openConfigStore(rootConfigLayout(domain.root)).read(),
      openOpsBindings(domain.root).record(frozen.target.alias)]);
    const selected = selectNotificationTarget(effectiveOps(config.document.ops), "diagnose-or-report");
    if (selected.state !== "selected" || canonicalJson(selected.target) !== canonicalJson(frozen.target)
      || !receiver || receiver.state !== "prepared" || !receiver.credentialPresent
      || receiver.bindingId !== frozen.binding.bindingId || receiver.revision !== frozen.binding.revision
      || canonicalJson(receiver.plan.scope) !== canonicalJson(frozen.scope)
      || receiver.automatic?.analysisAuthorized !== true || receiver.automatic.modelRevision !== frozen.binding.modelRevision
      || receiver.automatic.qualificationRevision !== frozen.binding.qualificationRevision)
      throw new HttpFailure(409, "source_changed", "The original analysis receiver permission is no longer current; no replacement was selected.");
  };
  const match = /^\/v1\/notification-tasks\/([^/]+)\/([^/]+)(\/evidence)?$/.exec(url.pathname);
  if (method === "GET" && match) {
    if (!UUID.test(match[1]!) || !UUID.test(match[2]!)) throw new HttpFailure(400, "invalid_input", "Invalid task locator.");
    const input = { databaseId: match[1]!, workId: match[2]!, principalId: principal.id };
    const task = await observed.notificationTask(input);
    if (!match[3]) return task; // Original receipts remain queryable, not renewed.
    // Evidence access is active analysis, so require current consent as well as
    // the original claim. Receipt lookup above does not authorize this read.
    const delivery = await observed.notificationDelivery(input.workId, input.databaseId);
    if (!delivery.attempt || !delivery.task) throw new HttpFailure(404, "not_found", "Task evidence is unavailable.");
    const records = await openOpsBindings(domain.root).records();
    const receiver = records.find(row => `notification-receiver:${row.bindingId}` === principal.id);
    if (!receiver || receiver.automatic?.analysisAuthorized !== true || receiver.state !== "prepared"
      || receiver.revision !== delivery.attempt.bindingRevision || receiver.plan.scope.databaseId !== input.databaseId)
      throw new HttpFailure(403, "permission_denied", "Current scoped analysis consent is required for evidence access.");
    const config = await openConfigStore(rootConfigLayout(domain.root)).read();
    const selected = selectNotificationTarget(effectiveOps(config.document.ops), "diagnose-or-report");
    if (selected.state !== "selected" || canonicalJson(selected.target) !== canonicalJson(receiver.plan.target))
      throw new HttpFailure(409, "source_changed", "Analysis policy changed.");
    await domain.authorizeTasks?.(signal);
    if (!domain.authorizeTasks) throw new HttpFailure(503, "source_unavailable", "Task authorization is unavailable.");
    return observed.notificationTaskEvidence(input);
  }
  const report = url.pathname === "/v1/notification-task-results";
  if (method !== "POST" || !report && url.pathname !== "/v1/notification-task-claims")
    throw new HttpFailure(404, "not_found", "Task endpoint not found.");
  const input = value as Record<string, unknown>;
  const keys = ["databaseId", "workId", "attemptId", "taskDigest", "requestId", ...(report ? ["claimId", "conclusion", "reportDigest"] : [])];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || Object.keys(input).some(key => !keys.includes(key))
    || !["databaseId", "workId", "attemptId", "requestId", ...(report ? ["claimId"] : [])].every(key => typeof input[key] === "string" && UUID.test(input[key]))
    || typeof input.taskDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.taskDigest)
    || report && (!["no-action-proposed", "repair-proposed", "inconclusive", "blocked"].includes(String(input.conclusion))
      || !(input.reportDigest === null || typeof input.reportDigest === "string" && /^[a-f0-9]{64}$/.test(input.reportDigest))))
    throw new HttpFailure(400, "invalid_input", "A task mutation requires exact original identifiers and a finite result, never free text or execution permission.");
  const storage = await readStorageConfiguration(domain.root), writer = openMonitorStore(domain.root, storage.monitor);
  const common = { databaseId: String(input.databaseId), workId: String(input.workId), attemptId: String(input.attemptId),
    taskDigest: input.taskDigest, requestId: String(input.requestId), principalId: principal.id, nowMs: Date.now(), authorize };
  return report ? writer.reportNotificationTask({ ...common, claimId: String(input.claimId),
    conclusion: input.conclusion as MaintenanceResult["conclusion"], reportDigest: input.reportDigest as string | null })
    : writer.claimNotificationTask(common);
}
