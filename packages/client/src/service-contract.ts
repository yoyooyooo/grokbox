/** Status of this authenticated management process, not supervisor installation
 * or execution/Provider authority. Worker facts retain their own freshness. */
export type ManagedWorkerView = {
  name: "monitor" | "notification-outbox" | "protection";
  owner: "management-server";
  started: boolean;
  state: string;
  reason: string | null;
  qualified: boolean;
  sideEffects: "local-observation" | "guarded-notification" | "guarded-protection";
};

export type EffectiveServicePolicy = {
  observation: { enabled: boolean; targetCount: number; notificationMode: "off" | "local_only" | "unknown"; revision: string | null };
  notifications: { enabled: boolean; authorizationRequired: true; directNative: false; mode: "off" | "local_only" | "unknown" };
  protection: { enabled: boolean; targetCount: number; defaultProtection: true; revision: string | null };
  storage: { admissionScope: "cooperating_diagnostic_writers"; writers: Array<"monitor" | "monitor-initialize" | "journal" | "process">; installationBudgetEnforced: false };
};

export type ManagementServiceView = {
  component: "server"; state: "running" | "stopping" | "stopped" | "failed";
  observation: {
    owner: "management-server";
    state: "not_configured" | "disabled" | "starting" | "running" | "degraded" | "blocked" | "stopping" | "stopped";
    reason: string | null; desiredRevision: string | null; collectorEpoch: string | null;
    startedAtMs: number; lastReceiptAtMs: number | null; replacements: number; targets: number;
    createsDatabase: false; notifiesDirectly: false; bootInstalled: false;
  };
  /** Present on current servers; optional for older authenticated clients. */
  workers?: ManagedWorkerView[];
  effectivePolicy?: EffectiveServicePolicy;
};
