import { Cause, Effect, Exit } from "effect";
import { runtimeServices, RuntimeServiceError, type RuntimeServiceRequest, type ServiceManager } from "../io/runtime-services.node.ts";

/** An explicit administrative operation, never a service started by a query.
 * Once an owned registration changes, cancellation waits for its finite writes
 * and manager calls to settle; it does not pretend to roll back manager state. */
export async function runRuntimeServiceCommand(input: RuntimeServiceRequest & { signal?: AbortSignal }, manager?: ServiceManager) {
  if (input.signal?.aborted) throw new RuntimeServiceError("cancelled");
  const operation = Effect.tryPromise({ try: () => runtimeServices(input, manager),
    catch: e => e instanceof RuntimeServiceError ? e : new RuntimeServiceError("unavailable") });
  const exit = await Effect.runPromiseExit(input.confirmed ? Effect.uninterruptible(operation) : operation, { signal: input.signal });
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = Cause.squash(exit.cause);
  throw cause instanceof RuntimeServiceError ? cause : new RuntimeServiceError(input.confirmed ? "installation_outcome_unknown" : "cancelled");
}
export { RuntimeServiceError, type RuntimeServiceRequest };
