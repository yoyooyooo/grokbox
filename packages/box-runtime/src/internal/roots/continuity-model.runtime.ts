import { Effect } from "effect";
import { runModelChange } from "@grokbox/runtime-kernel/commands";
import { applyModelChange, modelConfigurationRevision, parseModelChangeRequest, type ModelCaller, type ModelChangeRequest } from "@grokbox/runtime-kernel/model-management";
import { captureManagedSelection, parseRequestedEffort } from "@grokbox/runtime-kernel/selection";
import { continuityId, CurrentStateFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { readInstallation } from "../io/config-layout.node.ts";
import type { RuntimeStore } from "../io/configuration.node.ts";
import { modelConfigurationLayer } from "../io/model-management.node.ts";
import { managedModelAdmission } from "./model-management.runtime.ts";
import { openContinuityControls } from "./continuity-control.runtime.ts";

type Plan = { version: 1; caller: ModelCaller; change: ModelChangeRequest; modelRevision: string; assignmentRevision: string };
const changed = (): never => { throw new CurrentStateFailure("policy_changed"); };
/** A lifecycle stage binds an immutable request to the existing model domain.
 * CONT retains only the original plan. ModelConfiguration remains the sole
 * selection transaction/receipt owner, shared with the management Server.
 * Current content is never used to settle an unknown historical publication. */
export async function selectLifecycleModel(input: {
  store: RuntimeStore; workflow: BotWorkflowRequest; targetId: string; operationId: string;
  authorize: () => Promise<void>; verifyModel: () => Promise<void>; signal?: AbortSignal;
} & Parameters<typeof managedModelAdmission>[0]) {
  const { store, workflow, targetId, operationId } = input;
  input.signal?.throwIfAborted();
  const modelRevision = workflow.modelRevision;
  if (operationId !== continuityId(workflow.operationId, "model") || typeof modelRevision !== "string" || !/^[a-f0-9]{64}$/.test(modelRevision)) return changed();
  const installation = await readInstallation(store.root);
  if (!installation || installation.role !== "box" || installation.root !== store.root
    || workflow.management && workflow.management.installationId !== installation.installationId) return changed();
  const caller: ModelCaller = { installationId: installation.installationId,
    principalId: workflow.management?.principalId ?? `continuity:${workflow.scopeId}` };
  const controls = openContinuityControls({ durableRoot: store.root, scopeId: workflow.scopeId });
  const key = continuityId(workflow.operationId, "model-selection");
  let retained = await controls.read(key);
  const selection = workflow.modelRef === null ? { kind: "native" as const } : { kind: "model" as const, modelId: workflow.modelRef,
    ...(workflow.effort ? { reasoning: parseRequestedEffort(workflow.effort) } : {}) };
  const change = { kind: "bot-selection" as const, agentId: targetId, selection };
  if (!retained) {
    await input.authorize(); await input.verifyModel(); input.signal?.throwIfAborted();
    const current = await store.loadModels(), next = applyModelChange(current, change), captured = captureManagedSelection(next, targetId);
    const plan: Plan = { version: 1, caller, change: { requestId: operationId, expectedRevision: modelConfigurationRevision(current), change },
      modelRevision, assignmentRevision: captured.kind === "managed" ? captured.selectionRevision : "official" };
    await controls.reserve(key, targetId, "model-selection", plan);
    retained = await controls.read(key);
  }
  if (!retained || retained.agentId !== targetId || retained.kind !== "model-selection" || retained.state !== "prepared") return changed();
  const plan = retained.request as unknown as Plan;
  if (!plan || Object.keys(plan).sort().join() !== "assignmentRevision,caller,change,modelRevision,version" || plan.version !== 1
    || canonicalJson(plan.caller) !== canonicalJson(caller) || plan.modelRevision !== workflow.modelRevision
    || typeof plan.assignmentRevision !== "string" || !/^(?:official|[a-f0-9]{64})$/.test(plan.assignmentRevision)) return changed();
  const request = parseModelChangeRequest(plan.change);
  if (request.requestId !== operationId || canonicalJson(request.change) !== canonicalJson(change)) return changed();
  const admission = managedModelAdmission(input);
  const receipt = await Effect.runPromise(runModelChange(caller, request, (change, next) => Effect.gen(function* () {
    yield* Effect.tryPromise(() => input.authorize());
    yield* Effect.tryPromise(() => input.verifyModel());
    const finalCheck = yield* admission(change, next);
    yield* Effect.tryPromise(() => input.authorize());
    yield* Effect.tryPromise(() => input.verifyModel());
    return async () => {
      input.signal?.throwIfAborted();
      await input.authorize(); await input.verifyModel();
      input.signal?.throwIfAborted();
      await finalCheck();
    };
  })).pipe(Effect.provide(modelConfigurationLayer(store))), { signal: input.signal });
  if (receipt.state !== "succeeded") throw new CurrentStateFailure("commit_unknown");
  return { modelId: workflow.modelRef ?? "official", modelRevision: workflow.modelRevision,
    assignmentRevision: plan.assignmentRevision, operationId: receipt.requestId };
}
