import { Clock, Effect } from "effect";
import { BoxRuntimeError, decideManagedOwnership, OWNERSHIP_WAIT_MS } from "@grokbox/runtime-kernel/contract";

/** Borrowed narrow Gateway capability. The CLI root supplies the existing client;
 * no CLI import, native credential export or evidence trusted from run-step JSON. */
export type OwnershipReader = (agentIds: string[], signal: AbortSignal) => Promise<{
  snapshot: unknown;
  gateway: { pid: number; startedAt: number };
}>;
const denied = (reason: string) => new BoxRuntimeError("runtime_ownership_unavailable", reason);

export function readManagedOwnership(input: { agentId: string; read?: OwnershipReader; gatewayPid?: number }) {
  return Effect.gen(function* () {
    if (!input.read) return yield* Effect.fail(denied("ownership_reader_unavailable"));
    const result = yield* Effect.tryPromise({
      try: signal => input.read!([input.agentId], signal),
      catch: () => denied("ownership_read_unavailable"),
    }).pipe(Effect.timeout(`${OWNERSHIP_WAIT_MS} millis`), Effect.mapError(() => denied("ownership_read_unavailable")));
    if (!Number.isSafeInteger(result.gateway.pid) || result.gateway.pid < 1 || !Number.isSafeInteger(result.gateway.startedAt)
      || result.gateway.startedAt < 1 || (input.gatewayPid !== undefined && input.gatewayPid !== result.gateway.pid)) {
      return yield* Effect.fail(denied("ownership_gateway_mismatch"));
    }
    const decision = decideManagedOwnership({ agentId: input.agentId, snapshot: result.snapshot, nowMs: yield* Clock.currentTimeMillis });
    if (!decision.ok) return yield* Effect.fail(denied(decision.reason));
    return { evidence: decision.evidence, gateway: result.gateway };
  });
}
