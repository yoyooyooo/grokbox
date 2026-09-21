import { Clock, Context, Effect, Option, SynchronizedRef } from "effect";
import { AdmissionAuthority, BackendAuth, ConfigurationRead, ContextCompactionAlgorithm, HostCompact, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { captureContextSelection, InferenceMemory, type ContextMaintenanceExecution } from "@grokbox/runtime-kernel/inference";
import { ContextFailure, contextFailure, CONTEXT_MATERIAL_MAX_BYTES, WIRE_VERSION, OWNERSHIP_EVIDENCE_MAX_AGE_MS,
  type ContextMaintenanceRequest, type ContextMaintenanceReceipt, type ContextMaterial, type ContextCommitReceipt,
  type ContextCandidate, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseContextStart, CONTEXT_CONTROL_LIMIT, CONTEXT_PAGE_CHARS, type ContextAction } from "../wire/context-wire.ts";
import { readOneFrame, writeFrame, type Incoming } from "./server.node.ts";

export type MaintenanceRunner = {
  run: (input: ContextMaintenanceExecution) => Effect.Effect<ContextMaintenanceReceipt, ContextFailure,
    HostCompact | ContextCompactionAlgorithm | BackendAuth | ModelBackend>;
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = () => new ContextFailure("context_material_invalid");

/** The reverse channel offers only this operation's native root capability.
 * Serialized replies are paged; neither direction can submit executable JS. */
function nativeChannel(incoming: Incoming, request: ContextMaintenanceRequest, remaining: () => number) {
  let sequence = 0;
  const exchange = (action: ContextAction, candidate?: ContextCandidate, offset?: number) => Effect.gen(function* () {
    if (sequence >= CONTEXT_CONTROL_LIMIT || remaining() <= 0 || incoming.socket.destroyed) return yield* Effect.fail(new ContextFailure("deadline_exceeded"));
    const seq = sequence++;
    incoming.buf = Buffer.alloc(0);
    incoming.awaitingResume = true;
    return yield* Effect.gen(function* () {
      yield* writeFrame(incoming.socket, { version: WIRE_VERSION, method: "context-call", operationId: request.operationId,
        sequence: seq, action, ...(candidate ? { candidate } : {}), ...(offset !== undefined ? { offset } : {}) });
      const response = yield* readOneFrame(incoming, Math.max(1, Math.floor(remaining())));
      if (response.rest.length || !record(response.value)) return yield* Effect.fail(fail());
      const r = response.value;
      if (r.version !== WIRE_VERSION || r.method !== "context-result" || r.operationId !== request.operationId || r.sequence !== seq
        || Object.keys(r).some(k => !["version", "method", "operationId", "sequence", "chunk", "more", "error"].includes(k))) return yield* Effect.fail(fail());
      if (r.error !== undefined) return yield* Effect.fail(contextFailure({ code: r.error }, "context_material_invalid"));
      if (typeof r.chunk !== "string" || r.chunk.length > CONTEXT_PAGE_CHARS || typeof r.more !== "boolean") return yield* Effect.fail(fail());
      return { chunk: r.chunk, more: r.more };
    }).pipe(Effect.ensuring(Effect.sync(() => { incoming.awaitingResume = false; incoming.buf = Buffer.alloc(0); })),
      Effect.mapError(error => contextFailure(error, "cancelled")));
  });
  const call = (action: ContextAction, candidate?: ContextCandidate): Effect.Effect<unknown, ContextFailure> => Effect.gen(function* () {
    let reply = yield* exchange(action, candidate), text = reply.chunk;
    while (reply.more) {
      if (text.length > CONTEXT_MATERIAL_MAX_BYTES) return yield* Effect.fail(new ContextFailure("context_material_too_large"));
      reply = yield* exchange("page", undefined, text.length);
      if (!reply.chunk.length && reply.more) return yield* Effect.fail(fail());
      text += reply.chunk;
    }
    if (Buffer.byteLength(text) > CONTEXT_MATERIAL_MAX_BYTES) return yield* Effect.fail(new ContextFailure("context_material_too_large"));
    return yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: fail });
  });
  return call;
}

export function handleContextMaintenance(incoming: Incoming, raw: unknown, generation: string, runner: MaintenanceRunner,
  observe?: (request: ContextMaintenanceRequest, outcome: { receipt?: ContextMaintenanceReceipt; failure?: string }) => Effect.Effect<void, unknown>) {
  const disconnected = Effect.callback<never, ContextFailure>(resume => {
    const stop = () => resume(Effect.fail(new ContextFailure("cancelled")));
    incoming.socket.once("close", stop); incoming.socket.once("end", stop); incoming.socket.once("error", stop);
    if (incoming.socket.destroyed) stop();
    return Effect.sync(() => { incoming.socket.off("close", stop); incoming.socket.off("end", stop); incoming.socket.off("error", stop); });
  });
  const program = Effect.gen(function* () {
    const request = yield* Effect.try({ try: () => parseContextStart(raw), catch: fail });
    const now = yield* Clock.Clock;
    const started = now.monotonicTimeNanosUnsafe();
    const remaining = () => request.deadlineMs - Number(now.monotonicTimeNanosUnsafe() - started) / 1000000;
    const memory = yield* InferenceMemory;
    const configuration = yield* ConfigurationRead;
    const authority = yield* AdmissionAuthority;
    if (request.serviceEpoch.incarnationId !== generation || !authority.currentContext) return yield* Effect.fail(new ContextFailure("not_admitted"));
    const ctx = yield* Effect.context<never>();
    const algorithm = Context.getOption(ctx as Context.Context<ContextCompactionAlgorithm>, ContextCompactionAlgorithm);
    if (Option.isNone(algorithm)) return yield* Effect.fail(new ContextFailure("capability_unqualified"));
    const evidenceOwner = {};
    let retries = 0, spentMs = 0;
    let admittedScope: string | undefined;
    const authorize = Effect.gen(function* () {
      if (remaining() <= 0 || incoming.socket.destroyed) return yield* Effect.fail(new ContextFailure("cancelled"));
      const began = now.monotonicTimeNanosUnsafe();
      const result = yield* authority.currentContext!(request, { evidenceOwner, waitBudgetMs: Math.max(1, Math.min(10000 - spentMs, remaining())),
        takeRetry: () => Effect.sync(() => retries++ < 1) }).pipe(Effect.mapError(() => new ContextFailure("not_admitted")));
      spentMs += Number(now.monotonicTimeNanosUnsafe() - began) / 1000000;
      const wall = yield* Clock.currentTimeMillis;
      if (!result.admitted || !/^[a-f0-9]{64}$/.test(result.ownership.scopeId) || !result.ownership.serverId
        || !Number.isFinite(result.ownership.observedAtMs) || wall < result.ownership.observedAtMs
        || wall - result.ownership.observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return yield* Effect.fail(new ContextFailure("not_admitted"));
      if (request.reason === "manual" && request.manualApproval?.scopeId !== result.ownership.scopeId) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const scope = canonicalJson([result.ownership.scopeId, result.ownership.serverId]);
      if (admittedScope !== undefined && admittedScope !== scope) return yield* Effect.fail(new ContextFailure("not_admitted"));
      admittedScope = scope;
      // The native ownership read cannot resurrect a cancelled/revoked parent
      // or rotate the already-bound TURN's authority behind main admission.
      const selected = yield* captureContextSelection(request, { ownership: result.ownership }).pipe(
        Effect.provideService(ConfigurationRead, configuration), Effect.provideService(InferenceMemory, memory));
      if (request.reason === "manual" && request.manualApproval?.policyRevision !== selected.policy.revision) return yield* Effect.fail(new ContextFailure("not_admitted"));
    });
    yield* authorize;
    const capture = yield* captureContextSelection(request);
    let overflow: OverflowEvidence | undefined;
    if (request.reason === "overflow") {
      const parent = request.parent;
      if (!parent?.stepId || !parent.bindingId || !request.recoveryNonce) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const key = canonicalJson({ host: canonicalJson(request.hostEpoch), agentId: request.agentId, turnId: parent.turnId, stepId: parent.stepId });
      const ledger = memory.recoveries.get(key);
      const state = yield* SynchronizedRef.get(memory.ref);
      if (!ledger?.evidence || !ledger.nonceConsumed || ledger.compactInvocations !== 1 || ledger.managedAttempts !== 1
        || ledger.recoveryNonce !== request.recoveryNonce || ledger.tuple.bindingId !== parent.bindingId
        || ledger.tuple.selectionRevision !== request.selection.selectionRevision || state.ledger.get(key)?.status !== "active"
        || state.cancelled.has(key) || ledger.maintenanceOperationId && ledger.maintenanceOperationId !== request.operationId) return yield* Effect.fail(new ContextFailure("not_admitted"));
      ledger.maintenanceOperationId = request.operationId;
      overflow = ledger.evidence;
    }
    const native = nativeChannel(incoming, request, remaining);
    const host: HostCompact["Service"] = {
      request: () => Effect.succeed({ kind: "unavailable", reason: "capability_not_ready" }),
      maintenance: {
        startActivity: () => native("activity-start").pipe(Effect.asVoid),
        authorize: () => authorize.pipe(Effect.andThen(native("authorize")), Effect.flatMap(value => value === true ? Effect.void : Effect.fail(new ContextFailure("not_admitted")))),
        inspect: () => native("inspect") as Effect.Effect<ContextMaterial, ContextFailure>,
        preview: (_id, candidate) => native("preview", candidate) as Effect.Effect<ContextMaterial, ContextFailure>,
        commit: (_id, candidate) => native("commit", candidate) as Effect.Effect<ContextCommitReceipt, ContextFailure>,
        readCommit: () => native("readCommit") as Effect.Effect<ContextCommitReceipt | undefined, ContextFailure>,
      },
    };
    const auth = yield* BackendAuth;
    const pinned = yield* auth.pin({ apiKeyRef: capture.model.apiKeyRef }).pipe(Effect.mapError(() => new ContextFailure("auth_mismatch")));
    const secured = yield* captureContextSelection(request, { authFingerprint: pinned.fingerprint });
    const outcome = yield* Effect.result(runner.run({ request: { ...request, deadlineMs: Math.max(1, Math.floor(remaining())) },
      model: secured.model, policy: secured.policy, lease: pinned.lease, ...(overflow ? { overflow } : {}) }).pipe(
      Effect.provideService(HostCompact, host), Effect.provideService(ContextCompactionAlgorithm, algorithm.value)));
    if (observe) yield* observe(request, outcome._tag === "Success" ? { receipt: outcome.success } : { failure: outcome.failure.code }).pipe(Effect.timeout("100 millis"), Effect.ignore);
    if (outcome._tag === "Failure") return yield* Effect.fail(outcome.failure);
    yield* writeFrame(incoming.socket, { version: WIRE_VERSION, method: "context-terminal", operationId: request.operationId, ok: true,
      receipt: outcome.success, policy: capture.policy });
  });
  return Effect.raceFirst(program, disconnected).pipe(Effect.catch(error => writeFrame(incoming.socket, { version: WIRE_VERSION, method: "context-terminal", ok: false,
    error: contextFailure(error, "not_admitted").code }).pipe(Effect.ignore)));
}
