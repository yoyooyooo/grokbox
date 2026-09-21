import { Effect } from "effect";
import { ContinuityFailure, CurrentStateFailure, handoverPolicy, HANDOVER_KINDS, isContinuityUuid,
  type BotWorkflowRequest, type HandoverPlanItem } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

/** Requested activation or an existing target UUID is not a released target.
 * Shared with convergence so quiet observation cannot accrue before activation. */
export function replacementIsActivated(request: BotWorkflowRequest, workflow: { targetId: string | null; phase: string; steps: ReadonlyArray<{ step: string; state: string }> }): boolean {
  return request.kind === "replace" && request.activate && !!request.sourceId && !!workflow.targetId && workflow.targetId !== request.sourceId
    && workflow.phase !== "retired" && ["create", "initialize", "activate"].every(step => workflow.steps.some(row => row.step === step && row.state === "complete"));
}

export type HandoverEffect = { state: "complete" | "not_dispatched" | "unknown" | "unsupported"; evidence?: string;
  targetId?: string; routineId?: string; revision?: string; detail?: string };
export type BotHandoverPort = {
  authorize: (request: BotWorkflowRequest) => Promise<boolean>;
  discover: (request: BotWorkflowRequest, targetId: string, knownIds: readonly string[]) => Promise<{ items: HandoverPlanItem[]; coverage: "complete" | "partial" }>;
  inspect: (request: BotWorkflowRequest, item: HandoverPlanItem, completed: ReadonlyMap<string, HandoverEffect>) => Promise<HandoverEffect>;
  perform: (request: BotWorkflowRequest, item: HandoverPlanItem, completed: ReadonlyMap<string, HandoverEffect>) => Promise<HandoverEffect>;
};
const io = <A>(f: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: f,
  catch: error => error instanceof ContinuityFailure || error instanceof CurrentStateFailure ? error : new CurrentStateFailure("native_unavailable") }));

/** The workflow can already be active while individual relations remain open.
 * One item owns one side effect and an unknown item is inspected, never resent.
 * A readback proves the requested state, not that this controller caused it. */
export function openBotHandover(input: ContinuityStoreInput & { native: BotHandoverPort }, hooks: ContinuityStoreHooks = {}) {
  const store = continuityWorkflowPrograms(input, hooks), native = input.native;
  const advance = (operationId: string, maxItems = 16) => Effect.gen(function* () {
    if (!isContinuityUuid(operationId) || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 64) return yield* Effect.fail(new CurrentStateFailure("invalid_request"));
    const request = yield* store.request(operationId), workflow = yield* store.status(operationId), policy = handoverPolicy(request.handover);
    if (!replacementIsActivated(request, workflow)) return yield* Effect.fail(new CurrentStateFailure("not_prepared"));
    if (!(yield* io(() => native.authorize(request)))) return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    const current = yield* store.handoverItems(operationId);
    const discovery = yield* io(() => native.discover(request, workflow.targetId!, current.map(i => i.itemId)));
    if (!(yield* io(() => native.authorize(request)))) return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
    if (discovery.items.length > 1024) return yield* Effect.fail(new CurrentStateFailure("material_invalid"));
    for (const item of discovery.items) {
      if (!isContinuityUuid(item.itemId) || !HANDOVER_KINDS.includes(item.kind) || item.dependsOn.length > 8 || item.dependsOn.some(id => !isContinuityUuid(id))) return yield* Effect.fail(new CurrentStateFailure("material_invalid"));
      yield* store.putHandover(operationId, item.itemId, item.kind, { ...item.input, dependsOn: item.dependsOn });
    }
    const items = yield* store.handoverItems(operationId), completed = new Map<string, HandoverEffect>();
    for (const item of items) if (item.state === "complete") completed.set(item.itemId, item.result as HandoverEffect);
    let attempted = 0;
    for (const row of items) {
      if (attempted >= maxItems || row.state === "complete") continue;
      const { dependsOn, ...data } = row.input;
      if (!Array.isArray(dependsOn) || dependsOn.some(id => !completed.has(id))) continue;
      if (data.targetId !== workflow.targetId) return yield* Effect.fail(new ContinuityFailure("integrity_failure"));
      const item: HandoverPlanItem = { itemId: row.itemId, kind: row.kind as HandoverPlanItem["kind"], dependsOn, input: data };
      if (!(yield* io(() => native.authorize(request)))) break;
      attempted++;
      const inspected = yield* io(() => native.inspect(request, item, completed)).pipe(Effect.catch(() => Effect.succeed({ state: "unknown" as const })));
      if (!(yield* io(() => native.authorize(request)))) break;
      if (inspected.state === "complete") {
        yield* store.settleHandover(operationId, item.itemId, row.state, "complete", inspected); completed.set(item.itemId, inspected); continue;
      }
      if (row.state === "effect_unknown") continue;
      if (inspected.state === "unsupported") {
        if (row.state !== "blocked") yield* store.settleHandover(operationId, item.itemId, row.state, "blocked", inspected);
        continue;
      }
      if (row.state === "blocked") continue;
      // Do not publish another dispatch merely because an earlier observation
      // was empty. prepared is the only initial dispatchable state.
      if (row.state !== "prepared") continue;
      yield* store.settleHandover(operationId, item.itemId, "prepared", "effect_unknown", null);
      // Persistent admission can outlive the permission used to prepare it.
      // A revoked claim remains unknown; it is not another dispatch permit.
      if (!(yield* io(() => native.authorize(request)))) return yield* Effect.fail(new CurrentStateFailure("policy_changed"));
      const result = yield* io(() => native.perform(request, item, completed)).pipe(Effect.catch(() => Effect.succeed({ state: "unknown" as const })));
      if (result.state === "complete") {
        yield* store.settleHandover(operationId, item.itemId, "effect_unknown", "complete", result); completed.set(item.itemId, result);
      } else if (result.state === "not_dispatched" || result.state === "unsupported") {
        yield* store.settleHandover(operationId, item.itemId, "effect_unknown", "blocked", result);
      }
    }
    const after = yield* store.handoverItems(operationId);
    return { operationId, sourceId: request.sourceId, targetId: workflow.targetId, state: "active_with_handover", coverage: discovery.coverage,
      count: after.length, remaining: after.filter(i => i.state !== "complete").length, unknown: after.filter(i => i.state === "effect_unknown").length,
      attempted, sourceDeleted: false, automaticDeleteConfigured: policy.automaticDelete };
  });
  const status = (operationId: string) => Effect.gen(function* () {
    const workflow = yield* store.status(operationId), items = yield* store.handoverItems(operationId);
    return { workflow, count: items.length, remaining: items.filter(i => i.state !== "complete").length,
      items: items.map(i => ({ itemId: i.itemId, kind: i.kind, state: i.state, result: i.result })) };
  });
  return { advance: (id: string, maxItems?: number, signal?: AbortSignal) => Effect.runPromise(advance(id, maxItems), signal ? { signal } : undefined),
    status: (id: string) => Effect.runPromise(status(id)) };
}
