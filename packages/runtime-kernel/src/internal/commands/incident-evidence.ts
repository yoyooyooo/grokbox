import { Clock, Effect } from "effect";
import { EvidenceRead, EvidenceStore } from "../../ports.ts";
import { BoxRuntimeError } from "../../contract.ts";
import { monitorUuid } from "../../monitor.ts";
import { OBSERVATION_RETENTION, type EvidenceView } from "../../observation.ts";

export type IncidentEvidenceCommand =
  | { kind: "read"; incidentId: string; revision?: number; view?: EvidenceView }
  | { kind: "capture"; incidentId: string; confirmed: boolean }
  | { kind: "lease"; incidentId: string; revision: number; durationMs: number; confirmed: boolean };

/** One command program for CLI and authorized Bot capabilities. Reading cannot
 * acquire the writer. SQLite commit settlement is never detached on cancellation. */
export function runIncidentEvidence(command: IncidentEvidenceCommand) {
  return Effect.gen(function*() {
    if (!monitorUuid(command.incidentId)) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "monitor_invalid_incident_id"));
    if (command.kind === "read") {
      if (command.revision !== undefined && (!Number.isSafeInteger(command.revision) || command.revision < 1)) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "monitor_invalid_evidence_revision"));
      const view = command.view ?? "local-diagnostic";
      if (!["local-diagnostic", "bot-diagnostic", "public-summary"].includes(view)) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "monitor_invalid_evidence_view"));
      return yield* (yield* EvidenceRead).read({ incidentId: command.incidentId, revision: command.revision, view });
    }
    if (!command.confirmed) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "monitor_requires_confirm"));
    const nowMs = yield* Clock.currentTimeMillis;
    const store = yield* EvidenceStore;
    if (command.kind === "capture") return yield* Effect.uninterruptible(store.capture(command.incidentId, nowMs));
    if (!Number.isSafeInteger(command.revision) || command.revision < 1 || !Number.isSafeInteger(command.durationMs)
      || command.durationMs < 1 || command.durationMs > OBSERVATION_RETENTION.leaseMaxTotalMs) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "monitor_invalid_evidence_lease"));
    return yield* Effect.uninterruptible(store.lease({ ...command, nowMs }));
  });
}
