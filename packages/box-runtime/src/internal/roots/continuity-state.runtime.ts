import { Effect, Exit } from "effect";
import { ContinuityFailure, CurrentStateFailure, applicationObservation, assertCapturedHead, assertInitializationPermission,
  assertNativeBinding, captureCurrentRequest, continuityStorePolicy, initializationDigest, initializeCurrentRequest,
  nativeApplicationDigest, nativeCurrentHead, nativeQualification, sameCurrentHead, continuityId,
  type CaptureCurrentRequest, type InitializationAttempt, type InitializationPermission, type InitializeCurrentRequest,
  type NativeCurrentStatePort, type NativeQualification } from "@grokbox/runtime-kernel/continuity";
import { captureNativeCurrentMaterial, prepareNativeCurrentMaterial, verifyNativeCurrentApplication } from "../host/continuity-import.ts";
import { continuityStorePrograms, type ContinuityStoreInput } from "../io/continuity-store.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

const failure = (code: ConstructorParameters<typeof CurrentStateFailure>[0]) => new CurrentStateFailure(code);
const check = <A>(read: () => A) => Effect.try({ try: read,
  catch: e => e instanceof CurrentStateFailure || e instanceof ContinuityFailure ? e : failure("invalid_request") });
/** Each native primitive must be finite and settle before releasing its native
 * resource. Cancellation is observed between primitives, never by abandoning a
 * mutating Promise. No retry/timer, fabricated rollback or detached writer. */
const nativeIo = <A>(read: () => Promise<A>, code: ConstructorParameters<typeof CurrentStateFailure>[0] = "native_unavailable") =>
  Effect.uninterruptible(Effect.tryPromise({ try: read, catch: e => e instanceof CurrentStateFailure ? e : failure(code) }));
function usingNativeLease<L, A, E>(acquire: Effect.Effect<L, CurrentStateFailure>, use: (lease: L) => Effect.Effect<A, E>,
  release: (lease: L) => Promise<void>): Effect.Effect<A, E | CurrentStateFailure> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    const lease = yield* acquire;
    const used = yield* Effect.exit(restore(use(lease)));
    const closed = yield* Effect.exit(nativeIo(() => release(lease), "cleanup_unknown"));
    // Cleanup uncertainty is itself visible, including when use succeeded.
    // No result is allowed to claim ready while the native fence is unknown.
    if (Exit.isFailure(closed)) return yield* Effect.fail(failure("cleanup_unknown"));
    if (Exit.isFailure(used)) return yield* Effect.failCause(used.cause);
    return used.value;
  }));
}
export type CurrentStateInput = ContinuityStoreInput & {
  native?: NativeCurrentStatePort;
  /** Existing config/ownership authority must supply ORIGINAL fresh evidence.
   * This is an internal composition port, not a user-provided true/false flag. */
  authorizeInitialization?: (request: InitializeCurrentRequest) => Promise<InitializationPermission>;
};
export type InitializationResult = {
  state: "prepared" | "already_applied" | "reconciled" | "unknown" | "not_executed";
  operationId: string; effectId: string; current: "verified_prepared" | "at_imported_revision" | "advanced" | "not_checked";
  effectDispatched: boolean; activated: false; humanMessageSent: false;
};

/** CONT-07 application program over the real CONT store and a finite native
 * capability. No native implementation is installed by this factory. Missing
 * native/authority fails closed, including on schema/version changes. It does
 * not expose clone/reset/start or claim qualification of a product Host. */
export function continuityCurrentStatePrograms(input: CurrentStateInput, hooks: ContinuityStoreHooks = {}) {
  const store = continuityStorePrograms(input, hooks), policy = continuityStorePolicy(input.policy);
  const native = input.native;
  const requireNative = (): { port: NativeCurrentStatePort; qualification: NativeQualification } => {
    if (!native) throw failure("native_unavailable");
    return { port: native, qualification: nativeQualification(native.qualification) };
  };
  const authorize = (request: InitializeCurrentRequest) => nativeIo(async () => {
    if (!input.authorizeInitialization) throw failure("policy_changed");
    return assertInitializationPermission(await input.authorizeInitialization(structuredClone(request)), request, Date.now());
  }, "ownership_unconfirmed");
  const capture = (raw: CaptureCurrentRequest) => Effect.gen(function* () {
    const request = yield* check(() => captureCurrentRequest(raw));
    if (request.expected.scopeId !== input.scopeId) return yield* Effect.fail(failure("source_changed"));
    const prior = yield* store.publication(request.requestId).pipe(Effect.catch(e => e.code === "not_found" ? Effect.succeed(null) : Effect.fail(e)));
    if (prior) {
      if (prior.state !== "published") return { state: "reconcile_required" as const, publication: prior, sourceRead: false };
      const saved = yield* store.readSnapshot(request.requestId);
      yield* check(() => assertCapturedHead(saved, request.expected));
      return { state: "stored" as const, publication: saved.reference, sourceRead: false, nativeImportProven: false as const };
    }
    const { port, qualification } = yield* check(requireNative);
    yield* check(() => assertNativeBinding(request.expected, request.expected, qualification));
    const material = yield* usingNativeLease(nativeIo(() => port.capture(structuredClone(request.expected))),
      lease => nativeIo(() => captureNativeCurrentMaterial(lease, request.expected, qualification, policy)), lease => lease.release());
    // Release the native reader before any vault writes. The accepted bytes are
    // an immutable past checkpoint; no native state needs to stay locked here.
    const publication = yield* store.publish({ requestId: request.requestId, ...material });
    if (publication.state !== "published") return { state: "reconcile_required" as const, publication, sourceRead: true };
    return { state: "stored" as const, publication: publication.reference, sourceRead: true, nativeImportProven: false as const };
  });
  const attemptFor = (raw: InitializeCurrentRequest): InitializationAttempt => {
    const request = initializeCurrentRequest(raw);
    if (request.expected.scopeId !== input.scopeId) throw failure("source_changed");
    return { ...request, inputDigest: initializationDigest(request) };
  };
  const result = (attempt: InitializationAttempt, state: InitializationResult["state"], current: InitializationResult["current"], effectDispatched: boolean): InitializationResult => ({
    state, operationId: attempt.operationId, effectId: attempt.effectId, current, effectDispatched, activated: false, humanMessageSent: false,
  });
  const assertOperation = (op: Effect.Success<ReturnType<typeof store.operation>>, attempt: InitializationAttempt) => {
    if (op.kind !== "initialize" || op.agentId !== attempt.expected.agentId || op.inputDigest !== attempt.inputDigest || op.policyRevision !== attempt.policyRevision
      || op.snapshotId !== attempt.snapshot.ref || op.effectId !== null && op.effectId !== attempt.effectId) throw failure("operation_conflict");
  };
  const backupReference = (attempt: InitializationAttempt, action: "protect" | "release") => Effect.gen(function* () {
    if (!attempt.backupSnapshot) return;
    const change = yield* store.changeReference("continuity.recovery", {
      action, requestId: continuityId(attempt.operationId, "backup", action), claimId: continuityId(attempt.operationId, "backup"), reference: attempt.backupSnapshot });
    if (change.state !== (action === "protect" ? "protected" : "released")) return yield* Effect.fail(failure("material_invalid"));
  });
  const reconcileAttempt = (attempt: InitializationAttempt) => Effect.gen(function* () {
    const op = yield* store.operation(attempt.operationId);
    yield* check(() => assertOperation(op, attempt));
    if (op.state === "succeeded") { yield* backupReference(attempt, "release"); return result(attempt, "already_applied", "not_checked", false); }
    if (op.state === "not_executed") return result(attempt, "not_executed", "not_checked", false);
    if (op.state !== "effect_unknown") return result(attempt, "unknown", "not_checked", false);
    const { port, qualification } = yield* check(requireNative);
    const observed = yield* nativeIo(async () => {
      const value = applicationObservation(await port.observeApplication(attempt), attempt);
      if (value.current) assertNativeBinding(value.current, attempt.expected, qualification);
      return value;
    }, "commit_unknown");
    // Absence after a crash is not a proof of non-execution. Never replay,
    // recapture or call native prepare/commit from this reconciliation path.
    if (observed.state !== "applied") return result(attempt, "unknown", "not_checked", false);
    const evidenceHash = nativeApplicationDigest(observed.marker);
    yield* store.settleEffect(attempt.operationId, attempt.effectId, "succeeded", evidenceHash);
    yield* backupReference(attempt, "release");
    const same = observed.current.contextRevision === observed.marker.contextRevision && observed.current.rootHash === observed.marker.rootHash
      && observed.current.state === "prepared" && observed.current.effects === "clear";
    // Native-side readback certifies past application, NOT a repaired hold or
    // permission to activate after cleanup uncertainty. Explicit reconcile does
    // settle our management ledger above; it is a mutation, never a GET.
    return result(attempt, "reconciled", same ? "at_imported_revision" : "advanced", false);
  });
  const initialize = (raw: InitializeCurrentRequest) => Effect.gen(function* () {
    const attempt = yield* check(() => attemptFor(raw));
    const prior = yield* store.operation(attempt.operationId).pipe(Effect.catch(e => e.code === "not_found" ? Effect.succeed(null) : Effect.fail(e)));
    if (prior) {
      yield* check(() => assertOperation(prior, attempt));
      if (prior.state !== "prepared") return yield* reconcileAttempt(attempt);
    }
    const { port, qualification } = yield* check(requireNative);
    yield* check(() => assertNativeBinding(attempt.expected, attempt.expected, qualification));
    // Strip the derived digest before invoking the policy port: it accepts the
    // public request shape, not a second policy or a native DTO.
    const request: InitializeCurrentRequest = { operationId: attempt.operationId, effectId: attempt.effectId,
      snapshot: attempt.snapshot, expected: attempt.expected, policyRevision: attempt.policyRevision,
      ...(attempt.mode ? { mode: attempt.mode, backupSnapshot: attempt.backupSnapshot } : {}) };
    yield* authorize(request);
    if (attempt.backupSnapshot) {
      const backup = yield* store.readSnapshot(attempt.backupSnapshot.ref);
      if (backup.reference.revision !== attempt.backupSnapshot.revision) return yield* Effect.fail(failure("material_invalid"));
      yield* check(() => assertCapturedHead(backup, attempt.expected));
      yield* backupReference(attempt, "protect");
    }
    yield* store.prepareEffect({ operationId: attempt.operationId, agentId: attempt.expected.agentId, kind: "initialize",
      inputDigest: attempt.inputDigest, policyRevision: attempt.policyRevision, snapshotId: attempt.snapshot.ref });
    yield* store.rememberInitializationRequest(request);
    // prepareEffect keeps the snapshot reachable until this operation settles.
    const material = yield* store.readSnapshot(attempt.snapshot.ref);
    if (material.reference.revision !== attempt.snapshot.revision) return yield* Effect.fail(failure("material_invalid"));
    let disposition: "prepared" | "blocked" = "blocked";
    let dispatched = false;
    const verified = yield* usingNativeLease(nativeIo(() => port.initialize(attempt)), lease => Effect.gen(function* () {
      const candidate = yield* nativeIo(() => prepareNativeCurrentMaterial(lease, material, attempt, qualification, policy));
      yield* authorize(request);
      yield* nativeIo(async () => {
        if (!sameCurrentHead(nativeCurrentHead(await lease.readHead()), attempt.expected)) throw failure("source_changed");
      });
      // Only the short dispatch boundary is masked. A cancellation cannot leave
      // a native write unjoined. Readback remains an independent native step.
      yield* Effect.uninterruptible(Effect.gen(function* () {
        const claimed = yield* store.claimEffect(attempt.operationId, attempt.effectId, attempt.policyRevision);
        if (!claimed.dispatch) return yield* Effect.fail(failure("commit_unknown"));
        const permission = yield* authorize(request); // SQLite waiting did not refresh old evidence.
        yield* nativeIo(async () => {
          if (!sameCurrentHead(nativeCurrentHead(await lease.readHead()), attempt.expected)) throw failure("source_changed");
          // Reading the native head may itself take time: recheck original age
          // at the actual dispatch boundary, without extending its lifetime.
          assertInitializationPermission(permission, request, Date.now());
          dispatched = true;
          await lease.commit(attempt, candidate);
        }, "commit_unknown");
      }));
      const observation = yield* nativeIo(() => verifyNativeCurrentApplication(lease, attempt, candidate, qualification), "commit_unknown");
      disposition = "prepared";
      return observation;
    }), lease => lease.release(disposition));
    // Only after reopen AND successful fence release do we settle the ledger.
    // Lost settlement ack is independently reconciled from the native marker.
    yield* store.settleEffect(attempt.operationId, attempt.effectId, "succeeded", nativeApplicationDigest(verified.marker));
    yield* backupReference(attempt, "release");
    return result(attempt, "prepared", "verified_prepared", dispatched);
  });
  const reconcile = (raw: InitializeCurrentRequest) => Effect.gen(function* () {
    const attempt = yield* check(() => attemptFor(raw));
    return yield* reconcileAttempt(attempt);
  });
  return { capture, initialize, reconcile };
}

export function openContinuityCurrentState(input: CurrentStateInput, hooks: ContinuityStoreHooks = {}) {
  const programs = continuityCurrentStatePrograms(input, hooks);
  const run = <A>(program: Effect.Effect<A, CurrentStateFailure | ContinuityFailure>, signal?: AbortSignal): Promise<A> => {
    if (signal?.aborted) return Promise.reject(failure("cancelled"));
    return Effect.runPromise(program, signal ? { signal } : undefined);
  };
  return { capture: (request: CaptureCurrentRequest, signal?: AbortSignal) => run(programs.capture(request), signal),
    initialize: (request: InitializeCurrentRequest, signal?: AbortSignal) => run(programs.initialize(request), signal),
    reconcile: (request: InitializeCurrentRequest, signal?: AbortSignal) => run(programs.reconcile(request), signal) };
}
