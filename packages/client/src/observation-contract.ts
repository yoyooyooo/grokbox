/** Public observation projections. They describe retained observations, never
 * execution authority, raw diagnostic material or a collector's live process. */
export type ObservationFreshness = "fresh" | "stale" | "unavailable";
export type ObservedBot = {
  botRef: string; agentId: string;
  lastKnown: { state: "confirmed_box" | "confirmed_temporal" | "conflict" | "unconfirmed";
    serverHarness: "box" | "temporal" | null; localHarness: "box" | "temporal" | null } | null;
  lastAttemptMs: number | null; lastSuccessMs: number | null; freshness: ObservationFreshness;
};
/** Database-lifetime loss counters; normal pressure does not erase prior gaps. */
export type ObservationHealth = {
  pressureState: "normal" | "storage_pressure";
  droppedEvents: number; rejectedBatches: number;
};
export type ObservationSnapshot = {
  source: "local-observations"; admissionAuthority: false; coverage: "watched-bots-only";
  databaseId: string; collectorEpoch: string | null; scopeId: string | null; cursor: string; readAtMs: number;
  collector: { recordedRunning: boolean; liveness: "not-probed"; lastHeartbeatMs: number | null };
  storage: { schemaVersion: number };
  observationHealth: ObservationHealth;
  agents: ObservedBot[];
};
export type IncidentView = {
  id: string; incidentRef: string; scopeId: string; agentId: string | null; botRef: string | null;
  rule: string; status: "open" | "resolved" | "recorded";
  firstSeenAtMs: number; lastSeenAtMs: number; resolvedAtMs: number | null;
  revision: number; acknowledged: boolean; snoozeUntilMs: number | null;
};
export type IncidentList = {
  source: "local-observations"; coverage: "retained-incidents"; databaseId: string; collectorEpoch: string | null;
  incidents: IncidentView[]; nextCursor: string | null;
};
export type ObservationEvent = {
  eventId: string; seq: number; collectorEpoch: string; kind: string; scopeId: string;
  agentId: string | null; botRef: string | null; incidentId: string | null; incidentRef: string | null;
  observedAtMs: number; previousHarness: "box" | "temporal" | null; currentHarness: "box" | "temporal" | null;
  observationIntervalStartMs: number | null;
};
export type ObservationWatchFrame = { kind: "page"; page: ObservationEventPage }
  | { kind: "end"; cursor: string; reason: "duration" | "capacity" };
export type ObservationEventPage = {
  source: "local-observations"; coverage: "retained-events";
  entries: ObservationEvent[]; cursor: string; hasMore: boolean; retentionFloor: number;
  gap: "history-truncated" | null;
  observationHealth: ObservationHealth;
};
