import { canonicalJson, sha256Text } from "../../hash.ts";

export type ContextMode = "auto" | "manual";
export type ContextLimits = { maxSummaryRequests: number; maxSummaryInputTokens: number; timeoutMs: number };
export type ContextOverride = {
  windowTokens?: number;
  compaction?: {
    mode?: ContextMode;
    reserveTokens?: number;
    keepRecentTokens?: number;
    limits?: Partial<ContextLimits>;
  };
};
export type ContextIntent = ContextOverride & {
  models?: Record<string, ContextOverride>;
  agents?: Record<string, ContextOverride>;
};
export type ContextPolicy = {
  version: 1;
  windowTokens: number;
  compaction: { mode: ContextMode; reserveTokens: number; keepRecentTokens: number; limits: ContextLimits };
};
export type CapturedContextPolicy = ContextPolicy & { revision: string };
export type ContextBudget = {
  policyRevision: string;
  mode: ContextMode;
  declaredWindowTokens: number | null;
  localWindowTokens: number;
  windowTokens: number;
  outputTokens: number;
  reserveTokens: number;
  inputTokens: number;
  preferredTargetTokens: number;
  resumeThresholdTokens: number;
  keepRecentTokens: number;
};
export const CONTEXT_POLICY_VERSION = 1 as const;
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({
  version: CONTEXT_POLICY_VERSION,
  windowTokens: 128000,
  compaction: Object.freeze({ mode: "auto", reserveTokens: 16384, keepRecentTokens: 20000,
    limits: Object.freeze({ maxSummaryRequests: 16, maxSummaryInputTokens: 2000000, timeoutMs: 120000 }) }),
});
export class ContextPolicyError extends Error {
  readonly code = "context_policy_invalid";
  constructor() { super("context_policy_invalid"); this.name = "ContextPolicyError"; }
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ContextPolicyError();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) throw new ContextPolicyError();
}
function validateOverride(value: unknown): asserts value is ContextOverride {
  fields(value, ["windowTokens", "compaction"]);
  if (value.windowTokens !== undefined && !integer(value.windowTokens, 1024, 16777216)) throw new ContextPolicyError();
  if (value.compaction !== undefined) {
    const c = value.compaction;
    fields(c, ["mode", "reserveTokens", "keepRecentTokens", "limits"]);
    if (c.mode !== undefined && c.mode !== "auto" && c.mode !== "manual") throw new ContextPolicyError();
    if (c.reserveTokens !== undefined && !integer(c.reserveTokens, 1, 16777215)) throw new ContextPolicyError();
    if (c.keepRecentTokens !== undefined && !integer(c.keepRecentTokens, 0, 16777215)) throw new ContextPolicyError();
    if (c.limits !== undefined) {
      const l = c.limits;
      fields(l, ["maxSummaryRequests", "maxSummaryInputTokens", "timeoutMs"]);
      if (l.maxSummaryRequests !== undefined && !integer(l.maxSummaryRequests, 1, 64)) throw new ContextPolicyError();
      if (l.maxSummaryInputTokens !== undefined && !integer(l.maxSummaryInputTokens, 1, 16777216)) throw new ContextPolicyError();
      if (l.timeoutMs !== undefined && !integer(l.timeoutMs, 1000, 120000)) throw new ContextPolicyError();
    }
  }
}
export function validateContextIntent(value: unknown): ContextIntent {
  fields(value, ["windowTokens", "compaction", "models", "agents"]);
  validateOverride(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "models" && key !== "agents")));
  for (const domain of ["models", "agents"] as const) {
    const map = value[domain];
    if (map === undefined) continue;
    if (!plain(map) || Object.keys(map).length > (domain === "models" ? 128 : 1024)) throw new ContextPolicyError();
    for (const [key, child] of Object.entries(map)) {
      if (!key || key.length > 256 || /[\x00-\x1f]/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new ContextPolicyError();
      if (domain === "agents" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw new ContextPolicyError();
      validateOverride(child);
    }
  }
  // Check explicit common values; overrides can intentionally repair inherited defaults.
  const intent = structuredClone(value) as ContextIntent;
  const common = mergePolicy(DEFAULT_CONTEXT_POLICY, intent);
  assertPolicy(common);
  for (const override of Object.values(intent.models ?? {})) assertPolicy(mergePolicy(common, override));
  for (const override of Object.values(intent.agents ?? {})) assertPolicy(mergePolicy(common, override));
  return intent;
}
function mergePolicy(policy: Readonly<ContextPolicy>, override: ContextOverride): ContextPolicy {
  return { version: CONTEXT_POLICY_VERSION, windowTokens: override.windowTokens ?? policy.windowTokens,
    compaction: { ...policy.compaction, ...override.compaction,
      limits: { ...policy.compaction.limits, ...override.compaction?.limits } } };
}
function assertPolicy(policy: ContextPolicy): void {
  if (policy.compaction.reserveTokens >= policy.windowTokens
    || policy.compaction.keepRecentTokens >= policy.windowTokens - policy.compaction.reserveTokens) throw new ContextPolicyError();
}
/** Common effective intent, without choosing a model or granting a Bot execution. */
export function effectiveContextIntent(intent: ContextIntent | undefined): ContextIntent {
  const value = intent === undefined ? {} : validateContextIntent(intent);
  const policy = mergePolicy(DEFAULT_CONTEXT_POLICY, value);
  return { windowTokens: policy.windowTokens, compaction: policy.compaction,
    ...(value.models ? { models: value.models } : {}), ...(value.agents ? { agents: value.agents } : {}) };
}
export function captureContextPolicy(intent: ContextIntent | undefined, modelId: string, agentId: string): CapturedContextPolicy {
  const valid = intent === undefined ? {} : validateContextIntent(intent);
  let policy = mergePolicy(DEFAULT_CONTEXT_POLICY, valid);
  if (valid.models?.[modelId]) policy = mergePolicy(policy, valid.models[modelId]!);
  if (valid.agents?.[agentId]) policy = mergePolicy(policy, valid.agents[agentId]!);
  assertPolicy(policy);
  return { ...policy, revision: sha256Text(canonicalJson(["context-policy-v1", policy])) };
}
export function contextBudget(policy: CapturedContextPolicy, declaredWindow?: number, requestedOutput?: number, inputLimit?: number): ContextBudget {
  if (declaredWindow !== undefined && !integer(declaredWindow, 1, Number.MAX_SAFE_INTEGER)) throw new ContextPolicyError();
  if (requestedOutput !== undefined && !integer(requestedOutput, 1, Number.MAX_SAFE_INTEGER)) throw new ContextPolicyError();
  if (inputLimit !== undefined && !integer(inputLimit, 1, Number.MAX_SAFE_INTEGER)) throw new ContextPolicyError();
  const windowTokens = Math.min(policy.windowTokens, declaredWindow ?? policy.windowTokens);
  const outputTokens = requestedOutput ?? policy.compaction.reserveTokens;
  const reserveTokens = Math.max(policy.compaction.reserveTokens, outputTokens);
  const inputTokens = Math.min(windowTokens - reserveTokens, inputLimit ?? windowTokens);
  if (inputTokens <= 0) throw new ContextPolicyError();
  return {
    policyRevision: policy.revision, mode: policy.compaction.mode,
    declaredWindowTokens: declaredWindow ?? null, localWindowTokens: policy.windowTokens,
    windowTokens, outputTokens, reserveTokens, inputTokens,
    preferredTargetTokens: Math.floor(inputTokens * 0.60), resumeThresholdTokens: Math.floor(inputTokens * 0.90),
    keepRecentTokens: Math.min(policy.compaction.keepRecentTokens, Math.floor(inputTokens * 0.60)),
  };
}
export function summaryBudget(policy: CapturedContextPolicy, declaredWindow?: number, inputLimit?: number): ContextBudget {
  const window = Math.min(policy.windowTokens, declaredWindow ?? policy.windowTokens);
  return contextBudget(policy, declaredWindow, Math.min(8192, Math.floor(window / 8)), inputLimit);
}
