import { Effect } from "effect";
import {
  ContinuityFailure,
  type SelfResetCurrent,
  type SelfResetExecution,
  type SelfResetReceipt,
  type SelfResetRequest,
} from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";

export type SelfResetOwner = {
  current: () => Promise<SelfResetCurrent>;
  consume: (request: SelfResetRequest) => Promise<SelfResetExecution>;
};

export function openSelfResetQueue(input: ContinuityStoreInput, hooks: ContinuityStoreHooks = {}) {
  const programs = continuityWorkflowPrograms(input, hooks);
  const run = <A>(program: Effect.Effect<A, ContinuityFailure>, signal?: AbortSignal): Promise<A> => {
    if (signal?.aborted) return Promise.reject(new ContinuityFailure("cancelled"));
    return Effect.runPromise(program, signal ? { signal } : undefined);
  };
  const ownerFailure = (error: unknown) => error instanceof ContinuityFailure ? error : new ContinuityFailure("unavailable");
  const initialize = (signal?: AbortSignal) => run(programs.initialize(), signal);
  const admit = (request: SelfResetRequest, signal?: AbortSignal) => run(programs.enqueueSelfReset(request), signal).then(result => result.receipt);
  const inspect = (operationId: string, signal?: AbortSignal) => run(programs.selfReset(operationId), signal);
  const consume = async (operationId: string, owner: SelfResetOwner, signal?: AbortSignal): Promise<SelfResetReceipt> => {
    const request = await run(programs.selfResetRequest(operationId), signal);
    const current = await owner.current().catch(error => { throw ownerFailure(error); });
    const claim = await run(programs.claimSelfReset(operationId, current), signal);
    if (!claim.dispatch) return claim.receipt;
    try {
      if (signal?.aborted) throw new ContinuityFailure("cancelled");
      const execution = await owner.consume(request).catch(error => { throw ownerFailure(error); });
      return await run(programs.settleSelfReset(operationId, execution), signal);
    } catch (error) {
      const reason = error instanceof ContinuityFailure ? error.code : "unavailable";
      const unknown: SelfResetExecution = {
        state: "unknown",
        duties: request.duties.map(duty => ({ id: duty.id, state: "unknown" as const, reason })),
        reason,
      };
      await run(programs.settleSelfReset(operationId, unknown)).catch(() => undefined);
      return await run(programs.selfReset(operationId));
    }
  };
  return {
    initialize,
    admit,
    inspect,
    consume,
    list: (agentId: string, limit?: number, signal?: AbortSignal) => run(programs.listSelfResets(agentId, limit), signal),
  };
}
