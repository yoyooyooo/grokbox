import { Effect } from "effect";
import {
  ContinuityFailure, selfResetRequest, selfResetExecution,
  type SelfResetCurrent, type SelfResetExecution, type SelfResetReceipt, type SelfResetRequest,
} from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";

/** C2 must hold the native source gate from observation through the awaited
 * callback. It fences late tool/checkpoint/Memory writers by revision and
 * generation, binds scope/agent/policy, and does not await the requesting turn.
 * An unsettled turn is reported immediately; CONT keeps its request queued. */
export type SelfResetOwner = {
  withSource: <A>(request: SelfResetRequest, work: (current: SelfResetCurrent) => Promise<A>) => Promise<A>;
  consume: (request: SelfResetRequest) => Promise<SelfResetExecution>;
};

/** C1 persistence and consumption only; construction installs no native hook. */
export function openSelfResetQueue(input: ContinuityStoreInput, hooks: ContinuityStoreHooks = {}) {
  const programs = continuityWorkflowPrograms(input, hooks);
  const run = <A>(program: Effect.Effect<A, ContinuityFailure>, signal?: AbortSignal): Promise<A> => {
    if (signal?.aborted) return Promise.reject(new ContinuityFailure("cancelled"));
    return Effect.runPromise(program, signal ? { signal } : undefined);
  };
  const inspect = (operationId: string, signal?: AbortSignal) => run(programs.selfReset(operationId), signal);
  const consume = async (operationId: string, owner: SelfResetOwner, signal?: AbortSignal): Promise<SelfResetReceipt> => {
    const receipt = await inspect(operationId, signal);
    if (receipt.state !== "queued") return receipt;
    const request = await run(programs.selfResetRequest(operationId), signal);
    return owner.withSource(selfResetRequest(request), async current => {
      const claim = await run(programs.claimSelfReset(operationId, current), signal);
      if (!claim.dispatch) return claim.receipt;
      let execution: SelfResetExecution;
      try {
        if (signal?.aborted) throw new ContinuityFailure("cancelled");
        execution = selfResetExecution(await owner.consume(selfResetRequest(request)), request);
      } catch (error) {
        const reason = error instanceof ContinuityFailure ? error.code : "unavailable";
        execution = { state: "unknown", reason,
          duties: request.duties.map(duty => ({ id: duty.id, state: "unknown", reason })) };
      }
      // Always persist a settled owner result after dispatch, even when the
      // caller cancels. A failed/unknown COMMIT is surfaced; never dispatch again.
      return run(programs.settleSelfReset(operationId, execution));
    });
  };
  return {
    initialize: (signal?: AbortSignal) => run(programs.initialize(), signal),
    admit: (request: SelfResetRequest, signal?: AbortSignal) =>
      run(programs.enqueueSelfReset(request), signal).then(result => result.receipt),
    inspect,
    request: (operationId: string) => run(programs.selfResetRequest(operationId)),
    consume,
    /** Original-request observation only. No effects or retries are dispatched. */
    reconcile: (operationId: string, requestDigest: string, result: SelfResetExecution) =>
      run(programs.settleSelfReset(operationId, result, requestDigest)),
    list: (agentId: string, limit?: number, signal?: AbortSignal) => run(programs.listSelfResets(agentId, limit), signal),
  };
}
