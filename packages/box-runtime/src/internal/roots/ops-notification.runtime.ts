import { Effect } from "effect";
import { OpsNotification } from "@grokbox/runtime-kernel/ports";
import { runOpsNotification } from "@grokbox/runtime-kernel/commands";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { NotificationError, NOTIFICATION_DELIVERY_POLICY, selectNotificationTarget, validateNotificationBinding,
  projectNativeNotificationResult, type NoticeReplayFence, type NotificationBinding, type NotificationEnvelope, type NotificationScope, type NotificationTarget } from "@grokbox/runtime-kernel/observation";
import { openMonitorStore, type MonitorStoreOptions } from "../io/monitor-store.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { acquireConfigurationLease } from "../io/config-lock.node.ts";
import { readStorageConfiguration } from "../io/storage-configuration.node.ts";

/** T46 supplies a genuinely paired native driver. The default is unavailable;
 * the CLI cannot turn a URL, event payload or effective config into this port.
 * inspect must prove identity/model/routine/data and return no secret. send must
 * use only that exact binding and obey AbortSignal; no redirects or retries. */
export type PairedNotificationDriver = {
  inspect: (input: { target: NotificationTarget; scope: NotificationScope; signal?: AbortSignal }) => Promise<NotificationBinding | null>;
  send: (input: { binding: NotificationBinding; body: string; envelopeDigest: string; signal: AbortSignal }) => Promise<unknown>;
};
export type OpsNotificationInput = { durableRoot: string; workId: string; driver?: PairedNotificationDriver;
  signal?: AbortSignal; now?: () => number; storeOptions?: MonitorStoreOptions; replayFence?: NoticeReplayFence; managementOperationId?: string;
  automaticRetry?: true };
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new NotificationError("source_unavailable") });

/** One explicit iteration. No service/autostart installation, pairing or retry.
 * DB/config writes finish before leaving their scopes; native network is never
 * run under the SQLite transaction or configuration publication lock. */
export async function runOpsNotificationDelivery(input: OpsNotificationInput) {
  if (!monitorUuid(input.workId)) throw new NotificationError("invalid_work");
  const now = input.now ?? Date.now;
  const policy = async () => selectNotificationTarget(effectiveOps((await openConfigStore(rootConfigLayout(input.durableRoot)).read()).document.ops));
  const observedStore = openMonitorStore(input.durableRoot, input.storeOptions);
  const writeStore = async () => {
    const storage = await readStorageConfiguration(input.durableRoot);
    return openMonitorStore(input.durableRoot, { ...storage.monitor, ...input.storeOptions });
  };
  const program = runOpsNotification(input.workId).pipe(Effect.provideService(OpsNotification, {
    attempted: workId => io(async () => {
      const observed = await observedStore.notificationDelivery(workId, undefined, now());
      if (observed.state === "not_found") throw new NotificationError("work_not_found");
      return "attempt" in observed && observed.attempt !== null
        && !(input.automaticRetry === true && "retry" in observed && observed.retry?.state === "ready");
    }),
    route: () => io(policy),
    scope: () => io(() => observedStore.notificationScope()),
    inspect: (target, scope) => io(async () => {
      if (!input.driver || input.signal?.aborted) return null;
      const binding = await input.driver.inspect({ target, scope, signal: input.signal });
      return binding ? validateNotificationBinding(binding, target, scope, now()) : null;
    }),
    reserve: (workId, target, binding) => io(async () => {
      if (input.signal?.aborted) return { state: "blocked", reason: "cancelled_before_reservation" } as const;
      return (await writeStore()).reserveNotification({ workId, target, binding, nowMs: now(),
        ...(input.automaticRetry === true ? { automaticRetry: true as const } : {}),
        ...(input.managementOperationId ? { managementOperationId: input.managementOperationId } : {}) });
    }),
    begin: frozen => io(async () => {
      if (input.signal?.aborted) return { dispatch: false, reason: "cancelled_before_start" };
      // Serializes the last local policy read and the DB start transition against
      // the existing config writer. Subsequent disable is not in-flight cancel.
      const lock = await acquireConfigurationLease(input.durableRoot);
      try {
        const current = await policy();
        if (current.state !== "selected" || canonicalJson(current.target) !== canonicalJson(frozen.target)) return { dispatch: false, reason: "policy_changed" };
        return (await writeStore()).beginNotification({ workId: frozen.workId, attemptId: frozen.attemptId,
          envelopeDigest: frozen.envelopeDigest, bindingDigest: frozen.bindingDigest, nowMs: now() });
      } finally { await lock.release(); }
    }),
    send: (frozen, envelope: NotificationEnvelope, revalidated) => io(async () => {
      if (!input.driver) return { state: "definitely-not-accepted", reason: "unsupported" } as const;
      if (input.signal?.aborted || now() >= frozen.expiresAtMs) return { state: "definitely-not-accepted", reason: "expired" } as const;
      const binding = validateNotificationBinding(revalidated, frozen.target, frozen.scope, now());
      const body = canonicalJson(envelope);
      if (sha256Text(body) !== frozen.envelopeDigest || Buffer.byteLength(body) !== frozen.envelopeBytes
        || frozen.envelopeBytes > NOTIFICATION_DELIVERY_POLICY.maxBytes) throw new NotificationError("payload_changed");
      if (input.replayFence) {
        const work = await observedStore.notificationDelivery(frozen.workId);
        if (!("createdAtMs" in work) || typeof work.incidentFirstSeenAtMs !== "number" || typeof work.occurrenceIdentity !== "string"
          || input.replayFence.claim({ workId: frozen.workId, attemptId: frozen.attemptId, retryOf: frozen.retryOf,
            occurrenceIdentity: work.occurrenceIdentity, createdAtMs: work.createdAtMs,
            occurrenceAtMs: work.incidentFirstSeenAtMs, expiresAtMs: work.expiresAtMs, nowMs: now() }) !== null)
          throw new NotificationError("replay_fence_blocked");
      }
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), NOTIFICATION_DELIVERY_POLICY.deliveryTimeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
      try {
        // Await actual driver settlement, never detach a possible network write
        // merely because an outer timeout fired. Uncertain completion is durable.
        return projectNativeNotificationResult(await input.driver.send({ binding, body,
          envelopeDigest: frozen.envelopeDigest, signal }));
      } finally { clearTimeout(timer); }
    }),
    settle: (frozen, result) => io(async () => {
      const settled = await (await writeStore()).settleNotification({ workId: frozen.workId, attemptId: frozen.attemptId, result, nowMs: now() });
      if (input.replayFence && result.state === "definitely-not-accepted" && result.reason === "native_rejected") {
        const work = await observedStore.notificationDelivery(frozen.workId);
        if ("occurrenceIdentity" in work && typeof work.occurrenceIdentity === "string")
          input.replayFence.definitelyRejected({ occurrenceIdentity: work.occurrenceIdentity, workId: frozen.workId,
            attemptId: frozen.attemptId, nowMs: now() });
      }
      return settled;
    }),
  }));
  return Effect.runPromise(program, { signal: input.signal });
}
