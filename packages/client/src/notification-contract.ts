export type NotificationWorkerView = {
  owner: "management-server";
  state: "starting" | "waiting" | "working" | "stopped";
  cycles: number; lastCycleAtMs: number | null; nextDelayMs: number;
  lastCycle: { state: "idle" | "blocked" | "processed" | "unavailable"; reason: string;
    outcome?: "native-accepted" | "definitely-not-accepted" | "unknown" | "already_attempted" | "blocked" | "unavailable" } | null;
  automaticDiagnosis: false; automaticIssue: false; pollingCallsModels: false;
  serviceInstallation: "not_proven"; botReport: "not_observed"; userRead: "not_observed";
};
