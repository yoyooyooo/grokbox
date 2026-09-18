import { Effect } from "effect";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { effectiveOps, effectiveStorage } from "@grokbox/runtime-kernel/config";
import { continuitySource, continuitySourceKey, projectContinuityEvent,
  type ContinuitySource, type ContinuityEvent, type ContinuityStorageOwners, type ReferenceChange } from "@grokbox/runtime-kernel/observation";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { changeContinuityReference } from "../io/continuity-storage.node.ts";

export type ContinuityObservationBatch = {
  collectorEpoch: string; expectedCursor: string | null; nextCursor: string;
  atMs: number; events: readonly ContinuityEvent[];
};
/** Collector-owned sink for a stable CONT source. CONT commits its own operation
 * first and re-enters with the SAME event IDs/cursor if the receipt is lost.
 * This transaction never includes the CONT store, a Bot operation or a network
 * side effect. Missing collector/config/storage is an explicit unavailable exit. */
export function openContinuityObservationBridge(input: { durableRoot: string; source: ContinuitySource }) {
  const source = continuitySource(input.source), sourceKey = continuitySourceKey(source);
  const readStore = () => openMonitorStore(input.durableRoot);
  return {
    sourceKey,
    cursor: async () => {
      try { return { state: "observed" as const, value: await readStore().evidenceSourceStatus(sourceKey), quietPeriodProven: false }; }
      catch { return { state: "unavailable" as const, value: null, quietPeriodProven: false }; }
    },
    receipts: async (eventIds: readonly string[]) => {
      if (eventIds.length > 64 || eventIds.some(id => !monitorUuid(id))) return { state: "unsupported" as const, incidents: [] };
      try { return { state: "observed" as const, incidents: await readStore().linkedEvidenceIncidents(eventIds.map(id => `${sourceKey}:${id}`)) }; }
      catch { return { state: "unavailable" as const, incidents: [] }; }
    },
    publish: async (batch: ContinuityObservationBatch) => {
      const safe = Array.isArray(batch.events) && batch.events.length <= 64 ? batch.events.map(projectContinuityEvent) : [];
      if (!monitorUuid(batch.collectorEpoch) || !Number.isSafeInteger(batch.atMs) || batch.atMs < 1 || safe.length !== batch.events?.length || !safe.length
        || safe.some(e => !e || e.sourceInstanceId !== sourceKey || Date.parse(e.at) > batch.atMs + 60_000)
        || typeof batch.nextCursor !== "string" || !batch.nextCursor || batch.nextCursor.length > 2048 || /[\x00-\x1f]/.test(batch.nextCursor)
        || !(batch.expectedCursor === null || typeof batch.expectedCursor === "string" && batch.expectedCursor.length <= 2048)
        || new TextEncoder().encode(canonicalJson(safe)).length > 128 * 1024) return { state: "unsupported" as const, committed: false, transport: "unavailable" as const };
      const events = safe as ContinuityEvent[];
      batch = { collectorEpoch: batch.collectorEpoch, expectedCursor: batch.expectedCursor, nextCursor: batch.nextCursor, atMs: batch.atMs, events };
      for (let i = 1; i < events.length; i++) if (events[i]!.sourceSequence <= events[i - 1]!.sourceSequence) return { state: "unsupported" as const, committed: false, transport: "unavailable" as const };
      let notificationsEnabled: boolean, configRevision: string, store;
      try {
        const config = await openConfigStore(rootConfigLayout(input.durableRoot)).read();
        const ops = effectiveOps(config.document.ops);
        notificationsEnabled = ops.enabled !== false && (ops.notifications as { mode?: string }).mode !== "off";
        const policy = effectiveStorage(config.document.storage); configRevision = config.revision;
        store = openMonitorStore(input.durableRoot, { maxDatabaseBytes: policy.retention.monitor.maxBytes,
          retentionMs: policy.diagnostics.detailDays * 86400000, summaryMs: policy.diagnostics.summaryDays * 86400000 });
      } catch { return { state: "unavailable" as const, committed: false, reason: "configuration_unavailable", transport: "unavailable" as const }; }
      try {
        const gap = events.find(e => e.coverage.state !== "observed");
        const result = await store.ingestEvidence({ epoch: batch.collectorEpoch, sourceKey,
          expectedCursor: batch.expectedCursor, nextCursor: batch.nextCursor, atMs: batch.atMs, events,
          ...(gap ? { gap: gap.coverage.gapCodes.includes("unsupported_schema") ? "unsupported_schema" : gap.coverage.gapCodes.includes("retention") ? "retention" : "unavailable" } : {}),
          ...(!notificationsEnabled ? { notifications: "off" as const } : {}) });
        const sourceCoverage = await store.evidenceSourceStatus(sourceKey).catch(() => null);
        return { state: result.conflicts ? "conflict" as const : result.storagePressure || result.retirementSkipped || !sourceCoverage || Number(sourceCoverage.knownMissingEvents) > 0 || Number(sourceCoverage.conflicts) > 0 || !!sourceCoverage.gap ? "partial" as const : result.duplicate ? "duplicate" as const : "accepted" as const,
          committed: true, cursor: batch.nextCursor, inserted: result.inserted, conflicts: result.conflicts,
          retirementSkipped: result.retirementSkipped, droppedEvents: result.droppedEvents, storagePressure: result.storagePressure, sourceCoverage,
          configRevision, notifications: notificationsEnabled ? "local_intent_only" : "off", transport: "unavailable" as const,
          quietPeriodProven: false, domainOperationsChanged: false, crossStoreAtomic: false };
      } catch (e) {
        const reason = e instanceof Error ? e.message : "";
        return { state: reason === "monitor_commit_unknown" ? "unknown" as const : reason === "monitor_source_cursor_conflict" ? "conflict" as const : "unavailable" as const,
          committed: reason === "monitor_commit_unknown" ? "unknown" as const : false, transport: "unavailable" as const,
          replay: "same_event_identity_after_cursor_reconciliation" as const, domainOperationsChanged: false };
      }
    },
  };
}
/** Finite explicit mutation, settled on cancellation; not a business controller
 * and not a new periodic task. The native recovery owner is never auto-created. */
export function runContinuityReferenceChange(input: { owners: ContinuityStorageOwners; change: ReferenceChange; signal?: AbortSignal }) {
  if (input.signal?.aborted) return Promise.resolve({ state: "unavailable" as const, effect: "not_attempted" as const });
  return Effect.runPromise(Effect.uninterruptible(Effect.promise(() => changeContinuityReference(input.owners, input.change))), { signal: input.signal });
}
