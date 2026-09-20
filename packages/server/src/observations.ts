import { Effect } from "effect";
import { botRef, type IncidentList, type IncidentView, type ObservationEventPage, type ObservationSnapshot } from "@grokbox/client/contract";
import { incidentList, observationEvents, observationSnapshot } from "@grokbox/client";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import type { openMonitorStore } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { pageInput } from "./pagination.ts";

/** Existing observation owner, narrow query and incident-management capabilities.
 * Supplying it does not initialize/migrate storage or create a collector. GET
 * dispatch only uses the read subset; writes enter the incident program. */
export type ManagementObservations = Pick<ReturnType<typeof openMonitorStore>, "snapshot" | "incidentPage" | "events" | "incidentById" | "managementReceipt" | "manage">;
export const observationPaths = new Set(["/v1/observation", "/v1/incidents", "/v1/observation-events"]);
export function observationError(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof BoxRuntimeError) {
    if (["monitor_cursor_invalid", "monitor_cursor_expired"].includes(error.message)) return new HttpFailure(409, "cursor_gap", "The observation database, collector epoch or retained range changed. Obtain a new snapshot.");
    if (error.message === "monitor_not_initialized") return new HttpFailure(503, "source_unavailable", "Observation storage has not been initialized; this read did not create it.", { sourceState: "not_initialized" });
    if (["monitor_store_invalid", "monitor_store_schema_or_root_mismatch", "monitor_migration_required"].includes(error.message)) return new HttpFailure(503, "source_invalid", "The observation source needs explicit qualification or migration; this read did not modify it.");
  }
  return new HttpFailure(503, "source_unavailable", "The persisted observation source is unavailable; no empty or healthy result was substituted.");
}
export function projectIncident(installationId: string, databaseId: string, row: NonNullable<Awaited<ReturnType<ManagementObservations["incidentById"]>>>): IncidentView {
  return { id: row.id, incidentRef: `incident:${installationId}:${databaseId}:${row.id}`, scopeId: row.scopeId,
    agentId: row.agentId, botRef: row.agentId ? botRef(installationId, row.agentId) : null, rule: row.rule,
    status: row.status as IncidentView["status"], firstSeenAtMs: row.firstSeenAtMs, lastSeenAtMs: row.lastSeenAtMs,
    resolvedAtMs: row.resolvedAtMs, revision: row.revision, acknowledged: row.acknowledged, snoozeUntilMs: row.snoozeUntilMs };
}
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: error => error });
export function observationQuery(installationId: string, source: ManagementObservations | undefined, principal: Principal, url: URL) {
  return Effect.gen(function* () {
    const page = yield* checked(() => {
      requireCapability(principal, "observations.read");
      if (url.pathname === "/v1/observation") {
        if (url.search) throw new HttpFailure(400, "invalid_input", "Observation snapshots do not accept query parameters.");
        return { limit: 100, cursor: null };
      }
      const page = pageInput(url);
      if (page.cursor !== null && (!page.cursor.length || page.cursor.length > 256 || /[\x00-\x20\x7f]/.test(page.cursor))) {
        throw new HttpFailure(400, "invalid_input", "Invalid observation cursor.");
      }
      return page;
    });
    if (!source) return yield* Effect.fail(new HttpFailure(503, "source_unavailable", "The management service has no qualified observation reader."));
    const read = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: observationError });
    const invalid = () => new HttpFailure(503, "source_invalid", "The observation source does not match its public contract.");
    if (url.pathname === "/v1/observation") {
      const readAtMs = Date.now(), raw = yield* read(() => source.snapshot(readAtMs));
      const view = {
        source: "local-observations", admissionAuthority: false, coverage: "watched-bots-only",
        databaseId: raw.databaseId, collectorEpoch: raw.collectorEpoch, scopeId: raw.scopeId, cursor: raw.cursor, readAtMs,
        collector: { recordedRunning: raw.collectorRecordedRunning, liveness: "not-probed", lastHeartbeatMs: raw.lastHeartbeatMs },
        storage: { schemaVersion: raw.schemaVersion, migrationRequired: raw.storage.migrationRequired },
        agents: raw.agents.map(row => ({ agentId: row.agentId, botRef: botRef(installationId, row.agentId), lastKnown: row.lastKnown,
          lastAttemptMs: row.lastAttemptMs, lastSuccessMs: row.lastSuccessMs, freshness: row.freshness })),
      };
      if (!observationSnapshot(view, installationId)) return yield* Effect.fail(invalid());
      return view satisfies ObservationSnapshot;
    }
    if (url.pathname === "/v1/incidents") {
      const raw = yield* read(() => source.incidentPage(page.cursor ?? undefined, page.limit));
      const view = {
        source: "local-observations", coverage: "retained-incidents", databaseId: raw.databaseId, collectorEpoch: raw.collectorEpoch,
        incidents: raw.incidents.map(row => projectIncident(installationId, raw.databaseId, row)),
        nextCursor: raw.hasMore ? raw.cursor : null,
      };
      if (!incidentList(view, installationId, page.limit)) return yield* Effect.fail(invalid());
      return view satisfies IncidentList;
    }
    const raw = yield* read(() => source.events(page.cursor ?? undefined, page.limit));
    const databaseId = raw.cursor.split(":")[0];
    const view = {
      source: "local-observations", coverage: "retained-events", cursor: raw.cursor, hasMore: raw.hasMore, retentionFloor: raw.retentionFloor,
      gap: page.cursor === null && raw.retentionFloor > 0 ? "history-truncated" : null,
      entries: raw.entries.map(row => ({ eventId: row.eventId, seq: row.seq, collectorEpoch: row.collectorEpoch, kind: row.kind,
        scopeId: row.scopeId, agentId: row.agentId, botRef: row.agentId ? botRef(installationId, row.agentId) : null,
        incidentId: row.incidentId, incidentRef: row.incidentId ? `incident:${installationId}:${databaseId}:${row.incidentId}` : null,
        observedAtMs: row.observedAtMs, previousHarness: row.previousHarness, currentHarness: row.currentHarness,
        observationIntervalStartMs: row.observationIntervalStartMs })),
    };
    if (!observationEvents(view, installationId, page.limit, page.cursor ?? undefined)) return yield* Effect.fail(invalid());
    return view satisfies ObservationEventPage;
  });
}
