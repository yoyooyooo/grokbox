import { Effect } from "effect";
import { ConfigurationRead } from "../../ports.ts";
import { captureContextPolicy, contextBudget } from "../config/context-policy.ts";
import { modelForAgent } from "../../selection.ts";
import { ContextFailure, contextMaintenanceKey } from "../contract/context-maintenance.ts";
import { InferenceMemory } from "./route-binding.ts";

export type ContextStatusQuery = { agentId: string; sessionId: string; operationId?: string };
/** Pure projection of configuration and acknowledged metadata. It never restores
 * a native root or starts inference. Historical receipts do not prove current root. */
export function contextStatus(query: ContextStatusQuery) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory, config = yield* ConfigurationRead;
    const snapshot = yield* config.snapshot();
    const selected = yield* Effect.try({ try: () => modelForAgent(snapshot.models, query.agentId), catch: () => new ContextFailure("context_policy_invalid") });
    const policy = yield* Effect.try({ try: () => captureContextPolicy(snapshot.context, selected?.id ?? "", query.agentId), catch: () => new ContextFailure("context_policy_invalid") });
    const budget = selected ? yield* Effect.try({ try: () => contextBudget(policy, selected.contextWindowTokens), catch: () => new ContextFailure("context_policy_invalid") }) : null;
    const history = memory.history;
    const record = query.operationId && history.getMaintenance
      ? yield* history.getMaintenance(contextMaintenanceKey(query.agentId, query.sessionId, query.operationId))
      : history.getLatestMaintenance ? yield* history.getLatestMaintenance(query.agentId, query.sessionId) : undefined;
    if (record && (record.identity.agentId !== query.agentId || record.identity.sessionId !== query.sessionId
      || query.operationId !== undefined && record.identity.operationId !== query.operationId)) return yield* Effect.fail(new ContextFailure("maintenance_conflict"));
    return { version: 1 as const, agentId: query.agentId, sessionId: query.sessionId,
      configured: { managed: selected !== undefined && snapshot.desired.mode === "route", modelId: selected?.id ?? null, policy, budget },
      currentNativeRoot: "not-observed" as const,
      lastMaintenance: record ? { operationId: record.identity.operationId, updatedAtMs: record.updatedAtMs ?? null,
        hostEpoch: record.identity.hostEpoch, serviceEpoch: record.identity.serviceEpoch, state: record.state,
        summaryRequests: record.summaryRequests, summaryInputTokens: record.summaryInputTokens,
        failure: record.failure ?? null, receipt: record.receipt ?? null, detailsRetired: record.detailsRetired === true } : null };
  });
}
