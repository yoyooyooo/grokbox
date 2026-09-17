import { Clock, Context, Deferred, Effect, Option, SynchronizedRef } from "effect";
import { AdmissionAuthority, RuntimeEvents } from "../../ports.ts";
import { BindingFailure, type RunStepRequest } from "../contract/binding.ts";
import { STRICT_AUTHORITY_POLICY, authorityRefusalIsRevocation } from "../contract/authority-policy.ts";
import { REQUEST_WALL_DEADLINE_MS } from "../contract/limits.ts";
import { AUTHORITY_REASONS, annotateStreamFailure, projectStreamDiagnostic, streamFailureDiagnostic, type AuthorityDiagnostic } from "../contract/stream-diagnostic.ts";
import { projectAuthorityProgress, type AuthorityProgress } from "../contract/authority-progress.ts";
import { observationOwn } from "../contract/provider-observation.ts";
import type { OwnershipAdmission } from "../contract/ownership.ts";
import { InferenceMemory, bindingStoreKey, ledgerKey, turnKey, updateExecutionStateSync, type InferenceMemoryValue } from "./route-binding.ts";

/** Issued only by this process-local gate, never reconstructed from a wire DTO. */
export type AuthorityPermit = OwnershipAdmission & { readonly _AuthorityPermit: unique symbol };
const permits = new WeakMap<object, { stepKey: string; serviceEpoch: string; owner: InferenceMemoryValue;
  budget: object; issuedTick: bigint; ageMs: number }>();
const elapsed = (end: bigint, start: bigint) => Math.max(0, Number(end - start) / 1_000_000);

function denied(reason: unknown, checkpoint: AuthorityDiagnostic["checkpoint"], extra: Partial<AuthorityDiagnostic> = {}) {
  const safe = typeof reason === "string" && (AUTHORITY_REASONS as readonly string[]).includes(reason)
    ? reason as AuthorityDiagnostic["reason"] : "unknown";
  return annotateStreamFailure(new BindingFailure("not_admitted"), {
    rejectSite: "authority_check", authority: { ...extra, reason: safe, checkpoint },
  });
}

/** Revalidate a permit after an asynchronous credential check without another
 * remote read. Only objects issued by this gate qualify, and monotonic elapsed
 * time cannot be reset by a wall-clock correction or copied DTO. */
export function validateAuthorityPermit(request: RunStepRequest, permit: AuthorityPermit,
  checkpoint: NonNullable<AuthorityDiagnostic["checkpoint"]> = "after_auth") {
  return Effect.gen(function* () {
    const issuance = permits.get(permit), key = ledgerKey(request);
    const tick = yield* Clock.monotonicTimeNanos;
    const age = issuance && tick >= issuance.issuedTick ? issuance.ageMs + elapsed(tick, issuance.issuedTick) : Infinity;
    const memory = yield* InferenceMemory;
    const state = yield* SynchronizedRef.get(memory.ref);
    if (state.cancelled.has(key) || state.ledger.get(key)?.status === "cancelled") return yield* Effect.fail(new BindingFailure("cancelled"));
    const turn = state.turns.get(turnKey(request)), bound = state.bindings.get(bindingStoreKey(request));
    const wall = yield* Clock.currentTimeMillis;
    let reason: AuthorityDiagnostic["reason"] | undefined;
    if (!issuance || issuance.stepKey !== key || issuance.owner !== memory
      || issuance.serviceEpoch !== request.serviceEpoch.incarnationId || state.serviceEpoch !== issuance.serviceEpoch
      || issuance.budget !== memory.authoritySteps.get(key) || state.ledger.get(key)?.status !== "active"
      || !turn || tick < issuance.issuedTick) reason = "ownership_evidence_invalid";
    else if (!Number.isFinite(wall) || wall < permit.observedAtMs || !Number.isFinite(age)) reason = "ownership_clock_unavailable";
    else if (age > STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs || wall - permit.observedAtMs > STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs) reason = "ownership_evidence_stale";
    else if (turn.lifecycle !== "open") reason = turn.lifecycle === "revoked" ? "turn_revoked" : "turn_closed";
    else if (bound && (bound.ownership.scopeId !== permit.scopeId || bound.ownership.serverId !== permit.serverId)) reason = "ownership_identity_changed";
    if (reason) {
      yield* updateExecutionStateSync(memory, request, next => {
        const held = next.turns.get(turnKey(request));
        if (held?.lifecycle === "open") held.lifecycle = authorityRefusalIsRevocation(reason!) ? "revoked" : "closed";
        return next;
      });
      return yield* Effect.fail(denied(reason, checkpoint, { ...(Number.isFinite(age) ? { evidenceAgeMs: Math.ceil(age) } : {}) }));
    }
  });
}

/** The only checkpoint program. Retries belong to the source coordinator;
 * this owner supplies one cumulative allowance and keeps the claimed STEP alive.
 * The whole await, including backoff, is interruptible by the same STEP cancel. */
export function readAuthority(request: RunStepRequest, checkpoint: NonNullable<AuthorityDiagnostic["checkpoint"]> = "admission") {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const key = ledgerKey(request);
    const budget = memory.authoritySteps.get(key);
    if (!budget) return yield* Effect.fail(denied("authority_unavailable", checkpoint));
    const began = yield* Clock.monotonicTimeNanos;
    const remaining = Math.max(0, Math.min(STRICT_AUTHORITY_POLICY.stepWaitMs - budget.spentMs,
      REQUEST_WALL_DEADLINE_MS - elapsed(began, budget.startedTick)));
    const check = ++budget.check;
    const context = yield* Effect.context<never>();
    const events = Context.getOption(context as Context.Context<RuntimeEvents>, RuntimeEvents);
    const publish = (phase: AuthorityProgress["phase"], detail?: AuthorityDiagnostic, evidenceId?: string) => Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;
      const duration = Math.ceil(elapsed(now, began));
      const progress = projectAuthorityProgress({ version: 1, policyId: STRICT_AUTHORITY_POLICY.id,
        phase, checkpoint, check, elapsedMs: duration, cumulativeMs: Math.ceil(budget.spentMs + duration),
        remainingMs: Math.floor(Math.max(0, remaining - duration)), retries: budget.retries,
        reason: detail?.reason, evidenceId, diagnostic: detail });
      if (!progress) return;
      budget.progress = progress;
      if (Option.isSome(events)) yield* events.value.append({ name: "model_authority_progress", authority: progress }).pipe(
        Effect.timeout(`${STRICT_AUTHORITY_POLICY.observationWaitMs} millis`), Effect.catchCause(() => Effect.void));
    });
    const cancelled = Effect.gen(function* () {
      const state = yield* SynchronizedRef.get(memory.ref);
      return state.cancelled.has(key) || state.ledger.get(key)?.status === "cancelled";
    });
    const evaluate = Effect.gen(function* () {
      if (yield* cancelled) return yield* Effect.fail(new BindingFailure("cancelled"));
      const state = yield* SynchronizedRef.get(memory.ref);
      const existing = state.turns.get(turnKey(request));
      if (existing && existing.lifecycle !== "open") return yield* Effect.fail(denied(existing.lifecycle === "revoked" ? "turn_revoked" : "turn_closed", checkpoint));
      if (remaining <= 0) return yield* Effect.fail(denied("ownership_read_timeout", checkpoint, { waitBudgetMs: 0 }));
      yield* publish("waiting");
      const authority = yield* AdmissionAuthority;
      const result = yield* Effect.result(authority.current(request, {
        waitBudgetMs: Math.max(0, remaining - elapsed(yield* Clock.monotonicTimeNanos, began)),
        takeRetry: () => Effect.sync(() => {
          if (budget.retries >= STRICT_AUTHORITY_POLICY.maxStepReadRetries) return false;
          budget.retries++;
          return true;
        }),
      }));
      const durationMs = Math.ceil(elapsed(yield* Clock.monotonicTimeNanos, began));
      if (result._tag === "Failure") {
        const detail = streamFailureDiagnostic(result.failure)?.authority;
        return yield* Effect.fail(denied(detail?.reason ?? "authority_unavailable", checkpoint, { ...detail, durationMs }));
      }
      const value = result.success;
      const detail = projectStreamDiagnostic(observationOwn(value, "diagnostic"))?.authority;
      if (observationOwn(value, "admitted") !== true) return yield* Effect.fail(denied(observationOwn(value, "reason"), checkpoint, { ...detail, durationMs }));
      const fact = observationOwn(value, "ownership");
      const scopeId = observationOwn(fact, "scopeId"), serverId = observationOwn(fact, "serverId"), observedAtMs = observationOwn(fact, "observedAtMs");
      const now = yield* Clock.currentTimeMillis;
      if (typeof scopeId !== "string" || !/^[a-f0-9]{64}$/.test(scopeId)
        || typeof serverId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(serverId)
        || typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || !Number.isFinite(now) || observedAtMs > now
        || now - observedAtMs > STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs) {
        const age = typeof observedAtMs === "number" && Number.isFinite(observedAtMs) ? Math.max(0, now - observedAtMs) : undefined;
        return yield* Effect.fail(denied(age !== undefined && age > STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs ? "ownership_evidence_stale" : "ownership_evidence_invalid", checkpoint,
          { ...detail, durationMs, evidenceAgeMs: age }));
      }
      if (yield* cancelled) return yield* Effect.fail(new BindingFailure("cancelled"));
      const after = yield* SynchronizedRef.get(memory.ref);
      const turn = after.turns.get(turnKey(request)), bound = after.bindings.get(bindingStoreKey(request));
      if (turn && turn.lifecycle !== "open" || bound && (bound.ownership.scopeId !== scopeId || bound.ownership.serverId !== serverId)) {
        return yield* Effect.fail(denied(turn?.lifecycle === "revoked" ? "turn_revoked" : turn?.lifecycle === "closed" ? "turn_closed" : "ownership_identity_changed", checkpoint, { ...detail, durationMs }));
      }
      const permit = Object.freeze({ scopeId, serverId, observedAtMs }) as AuthorityPermit;
      permits.set(permit, { stepKey: key, serviceEpoch: request.serviceEpoch.incarnationId, owner: memory, budget,
        issuedTick: yield* Clock.monotonicTimeNanos,
        ageMs: Math.max(0, now - observedAtMs, detail?.ownershipRead?.serverEvidenceAgeMs ?? 0, detail?.ownershipWait?.sourceAgeMs ?? 0) });
      yield* publish("authorized", detail, value.admitted ? value.evidenceId : undefined);
      // Publication may suspend. Observation cannot refresh the original permit.
      yield* validateAuthorityPermit(request, permit, checkpoint);
      return permit;
    });
    const halt = memory.cancels.get(key);
    const waiting = halt ? Effect.raceFirst(evaluate, Deferred.await(halt).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled"))))) : evaluate;
    return yield* waiting.pipe(
      Effect.timeout(`${remaining} millis`),
      Effect.mapError(error => error instanceof BindingFailure ? error : denied("ownership_read_timeout", checkpoint, { waitBudgetMs: Math.floor(remaining) })),
      Effect.tapError(error => Effect.gen(function* () {
        const detail = streamFailureDiagnostic(error)?.authority;
        const isCancel = error.code === "cancelled";
        yield* publish(isCancel ? "cancelled" : "denied", detail);
        // Only a terminal refusal closes the TURN. Transient source failures
        // remain inside current() until recovery succeeds or its budget ends.
        if (!isCancel) yield* updateExecutionStateSync(memory, request, state => {
          const turn = state.turns.get(turnKey(request));
          if (turn && turn.lifecycle === "open") turn.lifecycle = authorityRefusalIsRevocation(detail?.reason ?? "") ? "revoked" : "closed";
          return state;
        });
      })),
      Effect.ensuring(Effect.gen(function* () {
        budget.spentMs += elapsed(yield* Clock.monotonicTimeNanos, began);
      })),
    );
  });
}
