/** Status of this authenticated management process, not supervisor installation
 * or execution/Provider authority. Worker facts retain their own freshness. */
export type ManagementServiceView = {
  component: "server"; state: "running" | "stopping" | "stopped" | "failed";
  observation: {
    owner: "management-server";
    state: "not_configured" | "disabled" | "starting" | "running" | "degraded" | "blocked" | "stopping" | "stopped";
    reason: string | null; desiredRevision: string | null; collectorEpoch: string | null;
    startedAtMs: number; lastReceiptAtMs: number | null; replacements: number; targets: number;
    createsDatabase: false; notifiesDirectly: false; bootInstalled: false;
  };
};
