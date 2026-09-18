import { Effect } from "effect";
import { EvidenceRead, EvidenceStore } from "@grokbox/runtime-kernel/ports";
import { runIncidentEvidence, type IncidentEvidenceCommand } from "@grokbox/runtime-kernel/commands";
import { openMonitorStore } from "../io/monitor-store.node.ts";

/** Host boundary for one command. The CLI neither acquires Effect services nor
 * receives a raw SQLite handle; all callers use the same kernel program. */
export async function runIncidentEvidenceCommand(input: { durableRoot: string; command: IncidentEvidenceCommand; signal?: AbortSignal }) {
  const store = openMonitorStore(input.durableRoot);
  const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: error => error });
  return Effect.runPromise(runIncidentEvidence(input.command).pipe(
    Effect.provideService(EvidenceRead, { read: query => io(() => store.incidentEvidence(query.incidentId, query.revision, query.view)) }),
    Effect.provideService(EvidenceStore, { capture: (id, now) => io(() => store.captureIncident(id, now)), lease: request => io(() => store.evidenceLease(request)) }),
  ), { signal: input.signal });
}
