import type { ContextBudget } from "./internal/config/context-policy.ts";
export type { ContextBudget };

/** Shared data contract. No execution, hashing backend, Node or Effect imports. */
export const CONTEXT_FAILURE_CODES = [
  "context_policy_invalid", "context_budget_exceeded", "context_fixed_input_too_large",
  "context_material_too_large", "context_material_invalid", "context_target_unreachable",
  "summary_unavailable", "summary_invalid", "no_improvement", "stale_root",
  "maintenance_budget_exhausted", "deadline_exceeded", "capability_unqualified",
  "commit_unknown", "operation_retired", "maintenance_conflict", "maintenance_busy", "native_cleanup_unknown", "cancelled", "not_admitted", "auth_mismatch",
] as const;
export type ContextFailureCode = typeof CONTEXT_FAILURE_CODES[number];
export class ContextFailure extends Error {
  constructor(readonly code: ContextFailureCode) { super(code); this.name = "ContextFailure"; }
}
export function contextFailureMessage(code: ContextFailureCode): string {
  const messages: Partial<Record<ContextFailureCode, string>> = {
    context_policy_invalid: "The local context policy has incompatible budgets. Review the captured window and output reserve.",
    context_budget_exceeded: "This request exceeds the local context budget. No main model request was sent; automatic maintenance is unavailable or manual mode is selected.",
    context_fixed_input_too_large: "The new input or fixed system/tool material cannot fit the local context window. Older-history compaction cannot make it fit.",
    context_material_too_large: "The context material exceeds the supported transfer or serialization limit. The original history was not silently truncated.",
    context_target_unreachable: "Compaction cannot leave enough working space while preserving the required input and tool groups.",
    summary_unavailable: "Context summarization could not complete. The pending input and original history remain available; the failed model STEP was not replayed.",
    summary_invalid: "The summary was empty, incomplete or invalid and was not accepted as a new context.",
    no_improvement: "Compaction did not produce a sufficiently smaller valid context. The original history was retained.",
    commit_unknown: "Context checkpoint completion is uncertain. Inspect the maintenance operation before retrying; the root may already have changed.",
    operation_retired: "This completed operation's detailed receipt was retired. Its identity remains consumed; it cannot start another summary or checkpoint.",
    maintenance_busy: "The session has another active context owner. Maintenance did not start a competing writer.",
    native_cleanup_unknown: "The native summary source has not confirmed shutdown. Do not start a competing maintenance operation.",
    maintenance_budget_exhausted: "Context maintenance reached its request or token budget before producing a valid replacement.",
    deadline_exceeded: "Context maintenance exhausted the current operation deadline. No additional model attempt was started.",
    capability_unqualified: "The loaded Host/modeld does not provide a qualified context maintenance capability.",
    cancelled: "Context maintenance was cancelled. Inspect the operation to distinguish an uncommitted candidate from an already-persisted root.",
    auth_mismatch: "The model credential no longer matches the captured TURN. No new summary request was authorized with the changed credential.",
  };
  return messages[code] ?? "Context maintenance could not safely continue. Inspect the operation and current session state.";
}
export function contextFailure(error: unknown, fallback: ContextFailureCode = "summary_unavailable"): ContextFailure {
  if (error instanceof ContextFailure) return error;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && (CONTEXT_FAILURE_CODES as readonly string[]).includes(error.code)) return new ContextFailure(error.code as ContextFailureCode);
  return new ContextFailure(fallback);
}

function fields(raw: unknown, names: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new ContextFailure("context_material_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== names.length || names.some(k => !descriptors[k] || !("value" in descriptors[k]!))) throw new ContextFailure("context_material_invalid");
  return Object.fromEntries(names.map(k => [k, descriptors[k]!.value]));
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown, maximum = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= maximum;
export type ContextManualApproval = { scopeId: string; hostGeneration: string; selectionRevision: string; policyRevision: string };
/** Binds the approved account, loaded Host, model and cost policy, not a future root. */
export function parseContextManualApproval(raw: unknown): ContextManualApproval {
  const value = fields(raw, ["scopeId", "hostGeneration", "selectionRevision", "policyRevision"]);
  if (!Object.values(value).every(hash)) throw new ContextFailure("not_admitted");
  return value as ContextManualApproval;
}
/** Canonical bytes shared by Node SHA-256 and browser WebCrypto. Explicit
 * sorted members keep this finite contract independent of a hash implementation. */
export function contextManualApprovalKey(agentId: string, input: ContextManualApproval): string {
  const { hostGeneration, policyRevision, scopeId, selectionRevision } = parseContextManualApproval(input);
  return JSON.stringify(["managed-compaction-v1", agentId, { hostGeneration, policyRevision, scopeId, selectionRevision }]);
}
export function parseContextBudget(raw: unknown): ContextBudget {
  const v = fields(raw, ["policyRevision", "mode", "declaredWindowTokens", "localWindowTokens", "windowTokens", "outputTokens", "reserveTokens", "inputTokens", "preferredTargetTokens", "resumeThresholdTokens", "keepRecentTokens"]);
  if (!hash(v.policyRevision) || typeof v.mode !== "string" || !["auto", "manual"].includes(v.mode)) throw new ContextFailure("context_policy_invalid");
  for (const key of ["localWindowTokens", "windowTokens", "outputTokens", "reserveTokens", "inputTokens", "preferredTargetTokens", "resumeThresholdTokens", "keepRecentTokens"]) {
    if (!count(v[key], 16777216)) throw new ContextFailure("context_policy_invalid");
  }
  const b = v as ContextBudget;
  if (b.localWindowTokens < 1024 || b.windowTokens <= 0 || b.outputTokens <= 0 || b.inputTokens <= 0
    || b.windowTokens > b.localWindowTokens || b.reserveTokens < b.outputTokens || b.inputTokens > b.windowTokens - b.reserveTokens
    || b.preferredTargetTokens !== Math.floor(b.inputTokens * 0.60) || b.resumeThresholdTokens !== Math.floor(b.inputTokens * 0.90)
    || b.keepRecentTokens > b.preferredTargetTokens || b.declaredWindowTokens !== null && (!count(b.declaredWindowTokens) || b.declaredWindowTokens < b.windowTokens)) throw new ContextFailure("context_policy_invalid");
  return b;
}
