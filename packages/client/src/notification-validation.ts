import type { NotificationWorkerView } from "./notification-contract.ts";
import { exact, record } from "./response-validation.ts";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function notificationWorker(value: unknown): value is NotificationWorkerView {
  if (!record(value) || !exact(value, ["owner", "state", "cycles", "lastCycleAtMs", "nextDelayMs", "lastCycle", "automaticDiagnosis", "automaticIssue", "pollingCallsModels", "serviceInstallation", "botReport", "userRead"])
    || value.owner !== "management-server" || !["starting", "waiting", "working", "stopped"].includes(String(value.state))
    || !integer(value.cycles) || !(value.lastCycleAtMs === null || integer(value.lastCycleAtMs) && value.lastCycleAtMs > 0)
    || !integer(value.nextDelayMs) || value.nextDelayMs < 1 || value.nextDelayMs > 300_000
    || value.automaticDiagnosis !== false || value.automaticIssue !== false || value.pollingCallsModels !== false
    || value.serviceInstallation !== "not_proven" || value.botReport !== "not_observed" || value.userRead !== "not_observed") return false;
  if (value.lastCycle === null) return value.cycles === 0 && value.lastCycleAtMs === null;
  const cycle = value.lastCycle;
  return value.cycles > 0 && value.lastCycleAtMs !== null && record(cycle)
    && exact(cycle, ["state", "reason", ...(cycle.outcome === undefined ? [] : ["outcome"])])
    && ["idle", "blocked", "processed", "unavailable"].includes(String(cycle.state))
    && typeof cycle.reason === "string" && /^[a-z][a-z_]{0,63}$/.test(cycle.reason)
    && (cycle.outcome === undefined || ["native-accepted", "definitely-not-accepted", "unknown", "already_attempted", "blocked", "unavailable"].includes(String(cycle.outcome)));
}
