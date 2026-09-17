import { BackendFailure } from "../contract/events.ts";
import { measureContext } from "../contract/context-maintenance.ts";
import { contextBudget, type CapturedContextPolicy } from "../config/context-policy.ts";
import { contextSnapshotBody, parseContextSnapshot, type ContextSnapshot } from "../contract/snapshot.ts";
import { computeSnapshotDigest } from "../../hash.ts";
import type { ModelRecord } from "../../selection.ts";

/** Main/auxiliary prepare cannot bypass the local hard budget even if the
 * caller omitted Host preflight. It does not prune or send a model request. */
export function budgetedContextSnapshot(model: ModelRecord, snapshot: ContextSnapshot, policy: CapturedContextPolicy): ContextSnapshot {
  const budget = contextBudget(policy, model.contextWindowTokens, snapshot.options.maxTokens);
  const measure = measureContext({ messages: [...snapshot.systemMessages, ...snapshot.messages].map((message, i) => ({ ref: `${i}`, message })), tools: snapshot.tools });
  if (measure.tokens > budget.inputTokens) throw new BackendFailure("context_budget_exceeded");
  const body = contextSnapshotBody({ ...snapshot, options: { ...snapshot.options, maxTokens: budget.outputTokens },
    contextBudget: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens, policyRevision: policy.revision } });
  return parseContextSnapshot({ ...body, snapshotDigest: computeSnapshotDigest(body) });
}
