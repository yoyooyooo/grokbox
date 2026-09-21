import { randomUUID } from "node:crypto";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { projectHostWitnessSnapshot, type HostRuntimeObservation, type HostWitnessObservation, type HostLeaseOpportunityLedger } from "@grokbox/runtime-kernel/host-health";
import { observeHostCompilation, type CompilationReadPorts } from "./host-compilation.node.ts";
export type HostWitnessRead = (challenge: string, signal: AbortSignal) => Promise<{ value: unknown; pid: number }>;
export type HostWitnessReadCursor = { observationId: string; sequence: number; eventTotal?: number; leaseOpportunity?: HostLeaseOpportunityLedger };
/** Challenge the existing native status wrapper, with no Bot/ownership request.
 * The nonce prevents stale response reuse, not a malicious same-UID process.
 * Before/after process inspection and exact compilation bind this local proof. */
export async function observeHostWitness(input: { root: string; runRoot: string; target: string; compilation: HostRuntimeObservation | null;
  read?: HostWitnessRead; previous?: HostWitnessReadCursor; inspect?: CompilationReadPorts }, parent: AbortSignal): Promise<HostWitnessObservation> {
  const outcome = (state: HostWitnessObservation["state"], reason: HostWitnessObservation["reason"]): HostWitnessObservation => ({ state, reason, observedAtMs: Date.now(), snapshot: null, qualified: false });
  const expected = input.compilation?.state === "current" ? input.compilation.receipt : null;
  if (!expected || expected.patch !== "applied" || expected.nativeCompilation !== "returned") return outcome("not-observed", "no-current-compilation");
  if (!input.read) return outcome("not-observed", "unsupported-reader");
  const challenge = randomUUID(), began = Date.now(), tick = performance.now(), signal = AbortSignal.any([parent, AbortSignal.timeout(3000)]);
  const sameLaunch = async () => {
    const observed = await observeHostCompilation(input.root, input.runRoot, input.target, input.inspect);
    return observed.state === "current" && canonicalJson(observed.receipt) === canonicalJson(expected);
  };
  try {
    signal.throwIfAborted();
    if (!await sameLaunch()) return outcome("different-generation", "generation-changed");
    signal.throwIfAborted();
    const reply = await input.read(challenge, signal);
    signal.throwIfAborted();
    // Invalid/failed old replies must not diagnose a replacement generation.
    // Reinspect before classifying either success OR detector failure.
    if (!await sameLaunch()) return outcome("different-generation", "generation-changed");
    signal.throwIfAborted();
    const snapshot = projectHostWitnessSnapshot(reply.value);
    if (!snapshot || snapshot.challenge !== challenge || reply.pid !== expected.pid || canonicalJson(snapshot.compilation) !== canonicalJson(expected)
      || snapshot.observedAtMs < began || snapshot.observedAtMs > Date.now() || performance.now() - tick > 3000
      || input.previous?.observationId === expected.observationId && snapshot.sequence <= input.previous.sequence) return outcome("invalid", "invalid-reply");
    const prior = input.previous?.observationId === expected.observationId ? input.previous : undefined;
    if (prior && snapshot.eventsDropped + snapshot.events.length < (prior.eventTotal ?? 0)) return outcome("invalid", "invalid-reply");
    if (prior?.leaseOpportunity) {
      const previous = prior.leaseOpportunity, next = snapshot.leaseOpportunity;
      if (!next || next.observed < previous.observed || next.missing < previous.missing
        || next.missing - previous.missing > next.observed - previous.observed
        || next.observed - previous.observed > snapshot.eventsDropped + snapshot.events.length - (prior.eventTotal ?? 0)
        || previous.firstMissing && canonicalJson(previous.firstMissing) !== canonicalJson(next.firstMissing)
        || next.observed === previous.observed && canonicalJson(next.last) !== canonicalJson(previous.last)
        || next.observed > previous.observed && (next.last?.sequence ?? 0) <= (previous.last?.sequence ?? 0)) return outcome("invalid", "invalid-reply");
    }
    return { state: "current", reason: "matched", observedAtMs: Date.now(), snapshot, qualified: false };
  } catch {
    if (!parent.aborted && !await sameLaunch()) return outcome("different-generation", "generation-changed");
    return outcome("unavailable", "read-unavailable");
  }
}
