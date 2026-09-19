import { Effect } from "effect";
import { ContinuityFailure, CurrentStateFailure, botWorkflowRequest, continuityId, isContinuityUuid,
  type BotWorkflowRequest, type WorkflowStep } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

export type BotLifecyclePort = {
  authorize: (request: BotWorkflowRequest, step: WorkflowStep) => Promise<{ allowed: boolean; scopeId: string; policyRevision: string; observedAtMs: number }>;
  capture: (request: BotWorkflowRequest, snapshotId: string) => Promise<{ snapshotId: string; revision: string; quality: string; gaps: string[] }>;
  create: (request: BotWorkflowRequest, operationId: string) => Promise<{ agentId: string; created: true; started: false }>;
  load: (request: BotWorkflowRequest, targetId: string) => Promise<{ agentId: string; loaded: true }>;
  model: (request: BotWorkflowRequest, targetId: string, operationId: string) => Promise<Record<string, unknown>>;
  compose: (request: BotWorkflowRequest, targetId: string, sourceSnapshotId: string | null, snapshotId: string) => Promise<{ snapshotId: string; revision: string; quality: string; gaps: string[] }>;
  initialize: (request: BotWorkflowRequest, targetId: string, snapshotId: string, operationId: string) => Promise<{ operationId: string; state: string }>;
  activate: (request: BotWorkflowRequest, targetId: string, initializationId: string) => Promise<Record<string, unknown>>;
  startup: (request: BotWorkflowRequest, targetId: string, operationId: string) => Promise<Record<string, unknown>>;
  handover: (request: BotWorkflowRequest, targetId: string) => Promise<Record<string, unknown>>;
};
const fail = (code: ConstructorParameters<typeof CurrentStateFailure>[0]) => new CurrentStateFailure(code);
const io = <A>(body: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: body,
  catch: error => error instanceof CurrentStateFailure || error instanceof ContinuityFailure ? error : fail("native_unavailable") }));

/** CLI and protection share this staged use case. Creation with an unknown
 * result never gets another dispatch. Idempotent ports reconcile their own
 * durable operation identities; they do not blindly repeat model/business work. */
export function botLifecyclePrograms(input: ContinuityStoreInput & { native: BotLifecyclePort }, hooks: ContinuityStoreHooks = {}) {
  const store = continuityWorkflowPrograms(input, hooks), native = input.native;
  const advance = (raw: BotWorkflowRequest) => Effect.gen(function* () {
    const request = yield* Effect.try({ try: () => botWorkflowRequest(raw), catch: () => fail("invalid_request") });
    if (request.scopeId !== input.scopeId) return yield* Effect.fail(fail("source_changed"));
    yield* store.initialize(); yield* store.create(request);
    const lastStep: WorkflowStep = request.kind === "replace" && request.activate ? "handover" : request.start ? "startup" : request.activate ? "activate" : "initialize";
    if ((yield* store.step(request.operationId, lastStep))?.state === "complete") {
      const phase=request.kind==="replace"&&request.activate?"active_with_handover":request.activate?"active":"ready";
      if((yield* store.status(request.operationId)).phase!=="retired")yield* store.phase(request.operationId,phase);
      return { ...(yield* store.status(request.operationId)), blocked: false };
    }
    let acknowledgedTarget: string | undefined;
    const authorize = (step: WorkflowStep) => io(async () => {
      const permission = await native.authorize(request, step), now = Date.now();
      if (!permission.allowed || permission.scopeId !== request.scopeId || permission.policyRevision !== request.policyRevision
        || !Number.isSafeInteger(permission.observedAtMs) || now < permission.observedAtMs || now - permission.observedAtMs > 5000) throw fail("policy_changed");
    });
    const stage = <A extends Record<string, unknown>>(name: WorkflowStep, replaySafe: boolean, perform: () => Promise<A>) => Effect.gen(function* () {
      const previous = yield* store.step(request.operationId, name);
      if (previous?.state === "complete") return previous.result as A;
      yield* authorize(name);
      const claimed = yield* store.beginStep(request.operationId, name);
      if (claimed.state === "complete") return claimed.result as A;
      if (!claimed.dispatch && !replaySafe) return yield* Effect.fail(fail("commit_unknown"));
      yield* authorize(name);
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        const result = yield* io(perform);
        if(!result||typeof result!=="object")return yield* Effect.fail(fail("commit_unknown"));
        if (name === "create") {
          if(!isContinuityUuid(result.agentId)||result.agentId===request.sourceId||result.created!==true||result.started!==false)return yield* Effect.fail(fail("commit_unknown"));
          acknowledgedTarget = result.agentId;
        }
        if((name==="capture"||name==="compose")&&(!isContinuityUuid(result.snapshotId)||typeof result.revision!=="string"||!/^[a-f0-9]{64}$/.test(result.revision)))return yield* Effect.fail(fail("material_invalid"));
        if(name==="activate"&&(result.state!=="released"||result.started!==false))return yield* Effect.fail(fail("commit_unknown"));
        const saved = yield* store.completeStep(request.operationId, name, result);
        return saved as A;
      }));
    });
    const drive = Effect.gen(function* () {
      const source = request.kind === "spawn" ? null : yield* stage("capture", true, () => native.capture(request, continuityId(request.operationId, "source-snapshot")));
      const created = yield* stage("create", false, () => native.create(request, continuityId(request.operationId, "birth")));
      const targetId = created.agentId;
      if (!isContinuityUuid(targetId) || targetId === request.sourceId) return yield* Effect.fail(fail("commit_unknown"));
      yield* stage("load", true, async () => { const result=await native.load(request,targetId);if(result.agentId!==targetId||result.loaded!==true)throw fail("source_changed");return result; });
      yield* stage("model", true, () => native.model(request, targetId, continuityId(request.operationId, "model")));
      const composed = yield* stage("compose", true, () => native.compose(request, targetId, source?.snapshotId ?? null, continuityId(request.operationId, "target-snapshot")));
      const initialized = yield* stage("initialize", true, async () => {
        const result = await native.initialize(request, targetId, composed.snapshotId, continuityId(request.operationId, "initialize"));
        if (!["prepared", "already_applied", "reconciled"].includes(result.state)) throw fail("commit_unknown");
        return result;
      });
      yield* store.phase(request.operationId, "ready");
      if (request.activate) {
        yield* stage("activate", true, () => native.activate(request, targetId, initialized.operationId));
        yield* store.phase(request.operationId, "active");
      }
      if (request.start) yield* stage("startup", true, async () => {
        const result = await native.startup(request, targetId, continuityId(request.operationId, "startup"));
        if (!result || result.state!=="settled" || result.started!==true || result.aborted===true || result.paused===true) throw fail("commit_unknown");
        return result;
      });
      if (request.kind === "replace" && request.activate) {
        yield* stage("handover", true, () => native.handover(request, targetId));
        yield* store.phase(request.operationId, "active_with_handover");
      } else yield* store.phase(request.operationId,request.activate?"active":"ready");
    });
    const outcome = yield* Effect.result(drive);
    if (outcome._tag === "Failure") {
      yield* store.phase(request.operationId, "blocked");
      return { ...(yield* store.status(request.operationId)), blocked: true, ...(acknowledgedTarget ? { knownTargetId: acknowledgedTarget } : {}),
        reason: outcome.failure instanceof CurrentStateFailure || outcome.failure instanceof ContinuityFailure ? outcome.failure.code : "unknown" };
    }
    return { ...(yield* store.status(request.operationId)), blocked: false };
  });
  return { advance, request: store.request, status: store.status, list: store.list };
}
export function openBotLifecycle(input: ContinuityStoreInput & { native: BotLifecyclePort }, hooks: ContinuityStoreHooks = {}) {
  const programs = botLifecyclePrograms(input, hooks);
  const run = <A>(effect: Effect.Effect<A, CurrentStateFailure | ContinuityFailure>, signal?: AbortSignal) => Effect.runPromise(effect, signal ? { signal } : undefined);
  return { advance: (request: BotWorkflowRequest, signal?: AbortSignal) => run(programs.advance(request), signal),
    request: (operationId: string) => run(programs.request(operationId)), status: (operationId: string) => run(programs.status(operationId)),
    list: (limit?: number) => run(programs.list(limit)) };
}
