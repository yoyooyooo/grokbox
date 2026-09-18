import { Effect } from "effect";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import { ContinuityFailure, duplicateRequest, duplicateSource, duplicatePlan, duplicateCreated, duplicateEffectId,
  DUPLICATION_POLICY_REVISION, DuplicateDispatchRefused, DuplicateReceiptUnstored, isContinuityHash, isContinuityUuid, type DuplicateRequest, type DuplicateTarget, type NativeDuplicatePort } from "@grokbox/runtime-kernel/continuity";
import { continuityStorePrograms, type ContinuityStoreInput } from "../io/continuity-store.node.ts";
import { continuityIo, type ContinuityStoreHooks } from "../io/continuity-database.node.ts";

/** Same durable safety owner as context initialization. No new journal, timer,
 * retry daemon or native writer; the original duplicate API performs copying.
 * A successful creation is stored before optional ownership readback. */
export function openAgentDuplication(input: ContinuityStoreInput & { native?: NativeDuplicatePort }, hooks: ContinuityStoreHooks = {}) {
  const store = continuityStorePrograms(input, hooks);
  const run = <A>(work: Effect.Effect<A, ContinuityFailure>, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(new ContinuityFailure("cancelled"));
    return Effect.runPromise(work, signal ? { signal } : undefined);
  };
  const inspect = (agentId: string) => continuityIo(async () => {
    if (!input.native) throw new ContinuityFailure("unavailable");
    const observed = duplicateSource(await input.native.inspectSource(agentId));
    if (observed.agentId !== agentId || observed.scopeId !== input.scopeId) throw new ContinuityFailure("scope_mismatch");
    return observed;
  });
  const execute = (raw: DuplicateRequest, confirmed: boolean) => Effect.gen(function* () {
    let request = duplicateRequest(raw);
    if (!confirmed || request.source.scopeId !== input.scopeId) return yield* Effect.fail(new ContinuityFailure("conflict"));
    yield* store.initialize();
    const saved = yield* store.prepareDuplication(request);
    request = saved.request; // The first durable intent owns its observation timestamp.
    if (saved.operation.state !== "prepared") return { ...saved, nativeDispatched: false, targetCheckedNow: false, target: null };
    const current = yield* inspect(request.source.agentId);
    if (duplicatePlan(current).revision !== request.planRevision) {
      yield* store.stopUnclaimedDuplication(request.operationId);
      return yield* Effect.fail(new ContinuityFailure("conflict"));
    }
    const beganAt = performance.now(), initialAge = Date.now() - current.observedAtMs, effectId = duplicateEffectId(request.operationId);
    const claim = yield* store.claimEffect(request.operationId, effectId, DUPLICATION_POLICY_REVISION);
    if (!claim.dispatch) return { ...(yield* store.duplication(request.operationId)), nativeDispatched: false, targetCheckedNow: false, target: null };
    // Once claimed, cancellation cannot turn a possibly successful remote write
    // into a new dispatch permit. Transport has its own finite deadline.
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const age = Date.now() - current.observedAtMs, elapsed = performance.now() - beganAt;
      if (initialAge < 0 || age < 0 || Math.max(age, initialAge + elapsed) > OWNERSHIP_EVIDENCE_MAX_AGE_MS || elapsed < 0) {
        yield* store.settleEffect(request.operationId, effectId, "not_executed", sha256Text("native-duplicate:authority-expired-before-dispatch"));
        return { ...(yield* store.duplication(request.operationId)), nativeDispatched: false, targetCheckedNow: false, target: null };
      }
      // No inferred roster diff/name match can manufacture this receipt. If
      // response or settlement is lost, retain effect_unknown and exact IDs.
      const response = yield* Effect.tryPromise({
        try: async () => duplicateCreated(await input.native!.duplicate(request, current), request),
        catch: cause => cause instanceof DuplicateDispatchRefused ? cause : new ContinuityFailure("commit_unknown"),
      }).pipe(Effect.catch(cause => cause instanceof DuplicateDispatchRefused
        ? Effect.succeed({ dispatchRefused: cause.reason } as const) : Effect.fail(cause)));
      if ("dispatchRefused" in response) {
        yield* store.settleEffect(request.operationId, effectId, "not_executed", sha256Text(`native-duplicate:${response.dispatchRefused}:not-dispatched`));
        return { ...(yield* store.duplication(request.operationId)), nativeDispatched: false, targetCheckedNow: false, target: null };
      }
      const completed = yield* store.recordDuplication(response).pipe(Effect.mapError(() => new DuplicateReceiptUnstored(response, request)));
      const target = yield* Effect.tryPromise({ try: async (): Promise<DuplicateTarget | null> => {
        const rawTarget = await input.native!.inspectTarget(response);
        if (!rawTarget || rawTarget.agentId !== response.targetAgentId || typeof rawTarget.readBack !== "boolean"
          || !["confirmed_box", "confirmed_temporal", "conflict", "unconfirmed"].includes(rawTarget.state)) return null;
        return { agentId: rawTarget.agentId, state: rawTarget.state, readBack: rawTarget.readBack };
      }, catch: () => new ContinuityFailure("unavailable") }).pipe(Effect.catch(() => Effect.succeed(null)));
      return { ...completed, nativeDispatched: true, targetCheckedNow: target !== null, target };
    }));
  });
  return {
    preview: (agentId: string, signal?: AbortSignal) => run(Effect.map(inspect(agentId), duplicatePlan), signal),
    execute: (command: { sourceAgentId: string; operationId: string; expectedPlanRevision: string; confirmed: boolean }, signal?: AbortSignal) => run(Effect.gen(function* () {
      if (!isContinuityUuid(command.sourceAgentId) || !isContinuityUuid(command.operationId) || !isContinuityHash(command.expectedPlanRevision)
        || command.confirmed !== true || !input.native) return yield* Effect.fail(new ContinuityFailure("invalid_material"));
      yield* store.initialize();
      const prior = yield* store.duplication(command.operationId).pipe(Effect.catchIf(e => e.code === "not_found", () => Effect.succeed(null)));
      if (prior && (prior.request.source.agentId !== command.sourceAgentId || prior.request.planRevision !== command.expectedPlanRevision)) return yield* Effect.fail(new ContinuityFailure("conflict"));
      if (prior) return yield* execute(prior.request, true);
      const source = yield* inspect(command.sourceAgentId);
      if (duplicatePlan(source).revision !== command.expectedPlanRevision) return yield* Effect.fail(new ContinuityFailure("conflict"));
      return yield* execute({ version: 1, operationId: command.operationId, source, planRevision: command.expectedPlanRevision }, true);
    }), signal),
    // Pure read: source may have disappeared, Host may be down, and the result
    // can still be inspected. Neither read migrates storage or invokes native.
    operation: (operationId: string) => run(store.duplication(operationId)),
  };
}
