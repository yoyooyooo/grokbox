import { Effect } from "effect";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { NOTICE_WORKER_POLICY, OBSERVATION_RETENTION, createNoticeReplayFence, selectNotificationTarget, type NoticeReplayFence, type NoticeAuthorization, type AutomaticNoticeCycle, type AutomaticNoticeWorkerStatus } from "@grokbox/runtime-kernel/observation";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { readStorageConfiguration } from "../io/storage-configuration.node.ts";
import type { NotificationRequest } from "../io/native-notification.node.ts";
import { createPreparedNoticeDriver, type ExplicitReceiverReader } from "./ops-explicit-delivery.runtime.ts";
import { runOpsNotificationDelivery } from "./ops-notification.runtime.ts";

export type { AutomaticNoticeCycle, AutomaticNoticeWorkerStatus } from "@grokbox/runtime-kernel/observation";
type Input = { durableRoot: string; readNative: ExplicitReceiverReader; signal?: AbortSignal; replayFence?: NoticeReplayFence };
type Ports = { request?: NotificationRequest };
const configuration = (root: string) => openConfigStore(rootConfigLayout(root));

/** Send only a future work under the exact durable permission selected by the
 * worker. Public explicit-send semantics are unchanged. Caller IDs cannot turn
 * an old work item, a prepared binding, or a changed generation into authority. */
export async function runAutomaticOpsNotification(input: Input & { workId: string; authorization: NoticeAuthorization }, ports: Ports = {}) {
  const config = await configuration(input.durableRoot).read();
  const route = selectNotificationTarget(effectiveOps(config.document.ops));
  if (route.state !== "selected") return { state: "blocked", reason: "notifications_policy_blocked" };
  const record = await openOpsBindings(input.durableRoot).record(route.target.alias);
  if (!record || record.state !== "prepared" || !record.automatic || canonicalJson(record.automatic) !== canonicalJson(input.authorization))
    return { state: "blocked", reason: "automatic_authorization_changed" };
  const work = await openMonitorStore(input.durableRoot).notificationDelivery(input.workId);
  // A work created now can describe a source failure buffered before consent.
  // Both immutable times must be inside this authorization's future window.
  const nowMs = Date.now();
  if (!("createdAtMs" in work) || typeof work.createdAtMs !== "number" || !Number.isSafeInteger(work.createdAtMs)
    || work.createdAtMs <= record.automatic.activatedAtMs || work.createdAtMs > nowMs
    || !("incidentFirstSeenAtMs" in work) || typeof work.incidentFirstSeenAtMs !== "number" || !Number.isSafeInteger(work.incidentFirstSeenAtMs)
    || work.incidentFirstSeenAtMs <= record.automatic.activatedAtMs || work.incidentFirstSeenAtMs > nowMs)
    return { state: "blocked", reason: "work_precedes_authorization" };
  const prepared = createPreparedNoticeDriver({ durableRoot: input.durableRoot, expectedBindingRevision: record.revision,
    expectedModelRevision: record.automatic.modelRevision, authorizationId: record.automatic.id, readNative: input.readNative, signal: input.signal }, ports);
  return runOpsNotificationDelivery({ durableRoot: input.durableRoot, workId: input.workId, driver: prepared.driver,
    signal: input.signal, replayFence: input.replayFence, automaticRetry: true });
}

/** One bounded pass. No database initialization, remote calls without eligible
 * work, authorization renewal, generic retry or alternative target selection. */
export async function automaticNoticeCycle(input: Input, ports: Ports = {}): Promise<AutomaticNoticeCycle> {
  try {
    if (input.signal?.aborted) return { state: "blocked", reason: "stopping" };
    const config = await configuration(input.durableRoot).read();
    const route = selectNotificationTarget(effectiveOps(config.document.ops));
    if (route.state !== "selected") return { state: "blocked", reason: route.reason };
    const record = await openOpsBindings(input.durableRoot).record(route.target.alias);
    if (!record || record.state !== "prepared" || !record.credentialPresent || !record.automatic)
      return { state: "blocked", reason: "automatic_not_authorized" };
    if (canonicalJson(record.plan.target) !== canonicalJson(route.target)) return { state: "blocked", reason: "target_policy_changed" };
    const auth = record.automatic, nowMs = Date.now();
    if (nowMs < auth.activatedAtMs) return { state: "blocked", reason: "clock_reversed" };
    const store = openMonitorStore(input.durableRoot);
    if (canonicalJson(await store.notificationScope()) !== canonicalJson(record.plan.scope)) return { state: "blocked", reason: "installation_scope_changed" };
    const replayFailure = input.replayFence?.check(nowMs);
    if (replayFailure) return { state: "blocked", reason: replayFailure };
    const workId = await store.nextAutomaticNotification(Math.max(auth.activatedAtMs, input.replayFence?.startedAtMs ?? 0,
      input.replayFence ? nowMs - OBSERVATION_RETENTION.notificationTtlMs : 0), nowMs);
    if (!workId) return { state: "idle", reason: "no_fresh_work", authorizationId: auth.id };
    const observed = input.replayFence ? await store.notificationDelivery(workId) : undefined;
    if (input.replayFence && (!observed || !("occurrenceIdentity" in observed) || typeof observed.occurrenceIdentity !== "string"))
      return { state: "blocked", reason: "replay_identity_unavailable", workId, authorizationId: auth.id };
    const priorAttempt = input.replayFence && observed && "occurrenceIdentity" in observed
      ? input.replayFence.priorAttempt(observed.occurrenceIdentity!, nowMs,
        "retry" in observed && observed.retry?.state === "ready" && observed.attempt
          ? { workId, attemptId: observed.attempt.attemptId } : undefined) : null;
    if (priorAttempt) {
      if (priorAttempt === "prior_lifetime_attempt" && observed && "occurrenceIdentity" in observed) {
        const storage = await readStorageConfiguration(input.durableRoot);
        await openMonitorStore(input.durableRoot, storage.monitor).quarantineRestoredNotification(workId, observed.occurrenceIdentity!);
      }
      return { state: "blocked", reason: priorAttempt, workId, authorizationId: auth.id };
    }
    if (!(await store.notificationBudgetAvailable(route.target, nowMs))) return { state: "blocked", reason: "wake_budget", authorizationId: auth.id };
    const result = await runAutomaticOpsNotification({ ...input, workId, authorization: auth }, ports);
    // Only finite status codes, never error strings, HTTP bodies, URLs or keys.
    const allowed = ["native-accepted", "definitely-not-accepted", "unknown", "already_attempted", "blocked", "unavailable"];
    const outcome = allowed.includes(result.state) ? result.state : "unknown";
    return { state: outcome === "blocked" || outcome === "unavailable" ? "blocked" : "processed",
      reason: outcome === "blocked" || outcome === "unavailable" ? "delivery_preflight_blocked" : "attempt_settled",
      workId, authorizationId: auth.id, outcome };
  } catch { return { state: "unavailable", reason: "local_or_native_source_unavailable" }; }
}

/** Owned by the management Server, never by a caller's HTTP request. Delay begins
 * after the previous pass settles. No overlapping pass, infinite catch-up, or
 * detached network write on shutdown. Outbox reservations fence other owners. */
export function startOpsNotificationWorker(input: Omit<Input, "signal">, testPorts: Ports & {
  idleMs?: number; blockedMs?: number; cycle?: (signal: AbortSignal) => Promise<AutomaticNoticeCycle>;
} = {}) {
  const idleMs = testPorts.idleMs ?? NOTICE_WORKER_POLICY.idleMs, blockedMs = testPorts.blockedMs ?? NOTICE_WORKER_POLICY.blockedMs;
  if (![idleMs, blockedMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= NOTICE_WORKER_POLICY.maxBlockedMs)) throw new Error("invalid_notice_worker_interval");
  const controller = new AbortController();
  const replayFence = createNoticeReplayFence(Date.now());
  const state: AutomaticNoticeWorkerStatus = { state: "starting", cycles: 0, lastCycleAtMs: null, lastCycle: null, nextDelayMs: idleMs,
    owner: "management-server", automaticDiagnosis: false, automaticIssue: false, pollingCallsModels: false,
    serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed" };
  let failures = 0;
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.state = "stopped"; }));
    yield* Effect.forever(Effect.gen(function* () {
      state.state = "working";
      const result = yield* Effect.uninterruptible(Effect.tryPromise({
        try: () => testPorts.cycle ? testPorts.cycle(controller.signal) : automaticNoticeCycle({ ...input, signal: controller.signal, replayFence }, testPorts),
        catch: () => "cycle_unavailable",
      }).pipe(Effect.catch(() => Effect.succeed({ state: "unavailable", reason: "local_or_native_source_unavailable" } as AutomaticNoticeCycle))));
      state.cycles = Math.min(Number.MAX_SAFE_INTEGER, state.cycles + 1); state.lastCycle = result; state.lastCycleAtMs = Date.now();
      failures = result.state === "blocked" || result.state === "unavailable" ? Math.min(failures + 1, 8) : 0;
      state.nextDelayMs = failures ? Math.min(NOTICE_WORKER_POLICY.maxBlockedMs, blockedMs * 2 ** (failures - 1)) : idleMs;
      state.state = "waiting";
      yield* Effect.sleep(`${state.nextDelayMs} millis`);
    }));
  }));
  const lifetime = Effect.runPromiseExit(program, { signal: controller.signal });
  return { status: (): AutomaticNoticeWorkerStatus => ({ ...structuredClone(state), replayFence: replayFence.status() }), close: async () => { controller.abort(); await lifetime; } };
}
