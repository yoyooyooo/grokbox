import { Cause, Clock, Effect, Queue, Stream } from "effect";
import { BackendFailure, type InferenceEvent } from "../contract/events.ts";
import { BindingFailure } from "../contract/binding.ts";
import { failureSummaryOf, annotateFailureSummary, projectFailureSummary } from "../contract/failure-summary.ts";
import { annotateProviderRecovery, type ProviderRecoveryPolicy, type ProviderRecoveryState } from "../contract/provider-recovery.ts";
import { sha256Text, canonicalJson } from "../../hash.ts";

export type RecoveryProgress = { current?: ProviderRecoveryState };
/** One logical STEP owner. Only known transient HTTP failures before ANY
 * meaningful output qualify. No tool executor, model fallback, transcript
 * mutation, background worker, or restart-resume permission lives here. */
export function withProviderRecovery<E, R>(input: {
  policy: ProviderRecoveryPolicy;
  identity: string;
  snapshotDigest: string;
  stream: (attemptId: string, ordinal: number) => Stream.Stream<InferenceEvent, E, R>;
  beforeAttempt: (ordinal: number) => Effect.Effect<void, unknown, R>;
  persist: (state: ProviderRecoveryState) => Effect.Effect<void, BindingFailure>;
  changed?: (state: ProviderRecoveryState) => Effect.Effect<void, unknown>;
  progress: RecoveryProgress;
}): Stream.Stream<InferenceEvent, unknown, R> {
  let consumed = false;
  return Stream.callback<InferenceEvent, unknown, R>((queue) => Effect.suspend(() => {
    if (consumed) return Queue.fail(queue, new BindingFailure("step_conflict"));
    consumed = true;
    let state: ProviderRecoveryState;
    let finished = false, publishedOutput = false;
    let lastFailure: unknown;
    const set = (next: ProviderRecoveryState) => Effect.gen(function* () {
      // Publishing progress does not confer execution authority. Only the exact
      // committed STEP record permits advancing to the next attempt.
      yield* input.persist(next);
      state = structuredClone(next); input.progress.current = structuredClone(next);
      if (input.changed) yield* input.changed(structuredClone(next)).pipe(Effect.catchCause(() => Effect.void));
    });
    const stop = (error: unknown, reason: ProviderRecoveryState["stopReason"]) => Effect.gen(function* () {
      if (!state) return error;
      const settledAtMs = yield* Clock.currentTimeMillis;
      const next = { ...state, phase: reason === "cancelled" ? "cancelled" as const : "stopped" as const, stopReason: reason,
        attempts: state.attempts.map(a => a.state === "claimed" || a.state === "dispatch_reserved"
          ? { ...a, state: "interrupted" as const, settledAtMs } : a) };
      const saved = yield* Effect.result(set(next));
      if (saved._tag === "Failure") {
        state = { ...next, settlementRecorded: false }; input.progress.current = structuredClone(state);
      }
      const failure = error instanceof Error ? error : new BackendFailure("provider_error");
      annotateProviderRecovery(failure, state);
      return failure;
    });
    const run = Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      state = { version: 1, policy: { ...input.policy }, phase: "running", stopReason: "pending", startedAtMs,
        deadlineAtMs: startedAtMs + input.policy.windowMs, attempts: [], outcomeUncertain: false, settlementRecorded: true };
      input.progress.current = structuredClone(state);
      yield* Effect.addFinalizer(() => {
        if (finished) return Effect.void;
        return Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const next: ProviderRecoveryState = { ...state, phase: "cancelled", stopReason: "cancelled", outcomeUncertain: state.attempts.length > 0,
            attempts: state.attempts.map(a => a.state === "claimed" || a.state === "dispatch_reserved" ? { ...a, state: "interrupted", settledAtMs: at } : a) };
          yield* set(next).pipe(Effect.interruptible, Effect.timeout("1 second"), Effect.catchCause(() => Effect.sync(() => {
            state = { ...next, settlementRecorded: false }; input.progress.current = structuredClone(state);
          })));
        });
      });
      for (;;) {
        const now = yield* Clock.currentTimeMillis, ordinal = state.attempts.length + 1;
        const attemptId = sha256Text(canonicalJson(["model-attempt-v1",input.identity,ordinal,input.snapshotDigest]));
        const { nextAttemptAtMs: _previousWait, ...resuming } = state;
        const claimed: ProviderRecoveryState = { ...resuming, phase: "running", stopReason: "pending",
          attempts: [...state.attempts,{id:attemptId,ordinal,snapshotDigest:input.snapshotDigest,state:"claimed",startedAtMs:now}] };
        const claim = yield* Effect.result(set(claimed));
        if (claim._tag === "Failure") {
          finished = true; state = { ...claimed, phase: "stopped", stopReason: "storage_unavailable", settlementRecorded: false };
          input.progress.current = structuredClone(state);
          const error = annotateProviderRecovery(claim.failure,state);
          annotateFailureSummary(error,projectFailureSummary({version:1,code:"ledger_unavailable",phase:"internal"}));
          return yield* Queue.fail(queue,error);
        }
        // Reserve before the last authority/configuration fence. A durable
        // reservation is not a claim that an HTTP request actually happened.
        yield* set({ ...state, attempts: state.attempts.map(a=>a.ordinal===ordinal?{...a,state:"dispatch_reserved"}:a) });
        const check = yield* Effect.result(input.beforeAttempt(ordinal));
        if (check._tag === "Failure") {
          const code = check.failure instanceof BindingFailure ? check.failure.code : "not_admitted";
          const reason = code === "selection_mismatch" ? "configuration_changed" : code === "cancelled" ? "cancelled" : "authority_changed";
          const error = yield* stop(check.failure,reason); finished = true; return yield* Queue.fail(queue,error);
        }
        // Authority/configuration may suspend. Rechecking only before the
        // fence would permit a new POST after the caller's retry window ended.
        if (ordinal > 1 && (yield* Clock.currentTimeMillis) >= state.deadlineAtMs) {
          const error = yield* stop(lastFailure ?? new BackendFailure("provider_error"), "deadline");
          finished = true; return yield* Queue.fail(queue, error);
        }
        let terminal: Extract<InferenceEvent,{type:"backend_finish"}> | undefined;
        // The entire attempt is a child scope. Its provider cancellation and
        // socket/reader cleanup complete locally before a new attempt starts.
        const result = yield* Effect.result(Effect.scoped(Stream.runForEach(input.stream(attemptId,ordinal), event => Effect.gen(function* () {
          if (terminal) return yield* Effect.fail(new BackendFailure("stream_invalid"));
          if(event.type==="backend_finish"){terminal=event;return;}
          if(event.type!=="text_delta"&&event.type!=="reasoning_delta"||event.text.length>0)publishedOutput=true;
          if(!(yield* Queue.offer(queue,event)))return yield* Effect.fail(new BindingFailure("cancelled"));
        }))));
        const at = yield* Clock.currentTimeMillis;
        if(result._tag === "Success" && terminal) {
          const completed: ProviderRecoveryState = { ...state, phase: terminal.finishReason === "stop" ? "succeeded" : "stopped",
            stopReason: terminal.finishReason === "stop" ? "success" : "not_retryable",
            attempts: state.attempts.map(a=>a.ordinal===ordinal?{...a,state:"completed",settledAtMs:at}:a) };
          const commit = yield* Effect.result(set(completed));
          if(commit._tag === "Failure"){
            finished=true; state={...completed,phase:"stopped",stopReason:"storage_unavailable",settlementRecorded:false};input.progress.current=structuredClone(state);
            const failure=annotateProviderRecovery(commit.failure,state);
            annotateFailureSummary(failure,projectFailureSummary({version:1,code:"ledger_unavailable",phase:"internal"}));
            return yield* Queue.fail(queue,failure);
          }
          finished=true; yield* Queue.offer(queue,terminal); return yield* Queue.end(queue);
        }
        const failure = result._tag === "Failure" ? result.failure : new BackendFailure("stream_invalid");
        lastFailure = failure;
        const facts = failureSummaryOf(failure), status = facts?.http?.status;
        const route = facts?.diagnostic?.stream?.route;
        yield* set({ ...state, outcomeUncertain:true,
          ...(facts?.http || route ? { lastUpstreamFailure: { ordinal, ...(facts?.http ? { http: facts.http } : {}), ...(route ? { route } : {}) } } : {}),
          attempts:state.attempts.map(a=>a.ordinal===ordinal?{...a,state:"failed",settledAtMs:at,...(status?{httpStatus:status}:{})}:a) });
        const eligible = failure instanceof BackendFailure && failure.code === "provider_error"
          && (facts?.category === "upstream_http" || facts?.category === "upstream_rate_limit")
          && status !== undefined && [429,502,503,504].includes(status);
        let reason: ProviderRecoveryState["stopReason"] | undefined;
        if(input.policy.mode!=="pre-output-http"||!input.policy.allowDuplicateInference)reason="disabled";
        else if(publishedOutput||terminal)reason="output_observed";
        else if(!eligible)reason="not_retryable";
        else if(ordinal>input.policy.maxExtraRequests)reason="attempt_budget";
        const retryAfter=facts?.http?.retryAfter;
        const remainingHeaderDelay=retryAfter?.delayMs===undefined?0:Math.max(0,retryAfter.observedAtMs+retryAfter.delayMs-at);
        const jitter=1+(parseInt(attemptId.slice(0,8),16)/0xffffffff)*0.2;
        const delay=Math.max(remainingHeaderDelay,Math.min(input.policy.maxDelayMs,Math.floor(input.policy.baseDelayMs*2**Math.min(ordinal-1,20)*jitter)));
        if(!reason && at+delay>=state.deadlineAtMs)reason="deadline";
        if(reason){const error=yield* stop(failure,reason);finished=true;return yield* Queue.fail(queue,error);}
        yield* set({...state,phase:"waiting",nextAttemptAtMs:at+delay});
        yield* Effect.sleep(`${delay} millis`);
        if((yield* Clock.currentTimeMillis)>=state.deadlineAtMs){const error=yield* stop(failure,"deadline");finished=true;return yield* Queue.fail(queue,error);}
      }
    });
    return run.pipe(Effect.catchCause(cause => {
      if(Cause.hasInterruptsOnly(cause))return Queue.end(queue);
      const failure=Cause.squash(cause);
      if(state){state={...state,phase:"stopped",stopReason:failure instanceof BindingFailure&&failure.code==="ledger_unavailable"?"storage_unavailable":"not_retryable",settlementRecorded:false};input.progress.current=structuredClone(state);}
      if(failure!==null&&typeof failure==="object"&&state)annotateProviderRecovery(failure,state);
      finished=true;return Queue.fail(queue,failure);
    }));
  }),{bufferSize:16,strategy:"suspend"});
}
