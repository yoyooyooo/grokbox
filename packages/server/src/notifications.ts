import type { NotificationWorkerView } from "@grokbox/client/contract";
import { projectNoticeWorker } from "@grokbox/runtime-kernel/observation";

/** Public service view omits private binding/authorization/work identifiers and
 * replay-fence internals. A native HTTP acceptance is never a read receipt. */
export function projectNotificationWorker(value: unknown): NotificationWorkerView {
  const worker = projectNoticeWorker(value);
  const lastCycle = worker.lastCycle ? { state: worker.lastCycle.state, reason: worker.lastCycle.reason,
    ...(worker.lastCycle.outcome ? { outcome: worker.lastCycle.outcome as NonNullable<NotificationWorkerView["lastCycle"]>["outcome"] } : {}) } : null;
  return { owner: worker.owner, state: worker.state, cycles: worker.cycles, lastCycleAtMs: worker.lastCycleAtMs,
    nextDelayMs: worker.nextDelayMs, lastCycle, automaticDiagnosis: false, automaticIssue: false,
    pollingCallsModels: false, serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed" };
}
