import type { ObservationHealth } from "@grokbox/client";

/** Database-lifetime evidence loss is separate from retention or display limits. */
export function ObservationHealthNotice({ health }: { health: ObservationHealth }) {
  if (health.pressureState === "normal" && health.droppedEvents === 0 && health.rejectedBatches === 0) return null;
  return <div className="notice" role="status" data-testid="observation-health">
    <strong>Observation coverage is incomplete</strong>
    <p>{health.pressureState === "storage_pressure" ? "Storage pressure is active." : "Storage pressure has recovered; earlier evidence loss remains."}</p>
    <p>Dropped evidence: {health.droppedEvents}. Rejected batches: {health.rejectedBatches}.</p>
    <p>These totals belong to this observation database. Refreshing, resuming collection or obtaining a new cursor does not restore missing evidence.</p>
  </div>;
}
