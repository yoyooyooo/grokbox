import type { ContextBudget, CapturedContextPolicy } from "../config/context-policy.ts";
import type { HostEpoch, SelectionIdentity, ServiceEpoch } from "./identity.ts";
import type { ResolvedModelSelection } from "../../selection.ts";
import { canonicalJson } from "../../hash.ts";
import { cloneJson, parsePromptMessages, buildModelEnvelope, type GenerationOptions, type PromptMessage, type ToolDefinition } from "./context.ts";

export type { ContextBudget, CapturedContextPolicy };
export const CONTEXT_MATERIAL_MAX_BYTES = 32 * 1024 * 1024;
export const CONTEXT_PAGE_MAX_BYTES = 1024 * 1024;
export const CONTEXT_MAX_MESSAGES = 65536;
export const CONTEXT_MAX_OPERATIONS = 64;
export const CONTEXT_METER_VERSION = "unicode-envelope-v1";
export const CONTEXT_ALGORITHM_VERSION = "pi-0.85.1-extraction-v1";
export const CONTEXT_FAILURE_CODES = [
  "context_policy_invalid", "context_budget_exceeded", "context_fixed_input_too_large",
  "context_material_too_large", "context_material_invalid", "context_target_unreachable",
  "summary_unavailable", "summary_invalid", "no_improvement", "stale_root",
  "maintenance_budget_exhausted", "deadline_exceeded", "capability_unqualified",
  "commit_unknown", "maintenance_conflict", "maintenance_busy", "native_cleanup_unknown", "cancelled", "not_admitted", "auth_mismatch",
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
export type ContextSourceMessage = {
  /** Opaque native source identity within the captured revision. Never a filesystem path. */
  ref: string;
  message: PromptMessage;
  preserve?: boolean;
  summary?: boolean;
};
export type ContextMaterial = {
  rootId: string;
  rootRevision: string;
  messages: ContextSourceMessage[];
  tools: ToolDefinition[];
  options: GenerationOptions;
};
export type ContextMeasure = {
  method: "estimate" | "usage-plus-estimate" | "tokenizer";
  meterVersion: string;
  tokens: number;
  estimatedTokens: number;
  uncertaintyTokens: number;
  bytes: number;
  messageCount: number;
  components: { system: number; messages: number; tools: number };
};
export type ContextPlan = {
  sourceRootRevision: string;
  summarizedRefs: string[];
  retainedRefs: string[];
  previousSummary?: string;
  /** Complete, bounded source coverage; chunks are summary text, not tool protocol messages. */
  chunks: string[];
  before: ContextMeasure;
  fixed: ContextMeasure;
  retained: ContextMeasure;
  splitTurn: boolean;
  effectiveKeepRecentTokens: number;
};
export type ContextCandidate = {
  operationId: string;
  sourceRootRevision: string;
  summary: string;
  summarizedRefs: string[];
  retainedRefs: string[];
  budget: ContextBudget;
};
export type ContextMaintenanceIdentity = {
  operationId: string;
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  sessionId: string;
  rootId: string;
  rootRevision: string;
  selection: SelectionIdentity;
  parent?: { turnId: string; stepId?: string; bindingId?: string };
};
export type ContextSelectionCapture = {
  version: 1;
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  turnId: string;
  selection: SelectionIdentity;
  model: ResolvedModelSelection;
  policy: CapturedContextPolicy;
  /** Credential identity only, never a secret or a lease; shared with main admission. */
  authFingerprint?: string;
};
export type ContextMaintenanceReason = "preflight" | "manual" | "overflow";
export type ContextMaintenanceRequest = ContextMaintenanceIdentity & {
  reason: ContextMaintenanceReason;
  confirmed?: boolean;
  /** Checked against the already-admitted kernel recovery ledger, never trusted alone. */
  recoveryNonce?: string;
  deadlineMs: number;
};
export type ContextMaintenanceStage = "checking" | "preparing" | "summarizing" | "validating" | "committing";
export type ContextSummaryInput = { messages: PromptMessage[]; maxOutputTokens: number };
export type ContextSummaryOutput = { text: string; finishReason: string; inputTokens?: number; outputTokens?: number };
export type ContextGeneratedSummary = { summary: string; requests: number; inputTokens: number };
export type ContextMaintenanceReceipt = {
  operationId: string;
  rootId: string;
  sourceRootRevision: string;
  rootRevision: string;
  outcome: "unchanged" | "committed";
  policyRevision: string;
  budget: ContextBudget;
  before: ContextMeasure;
  after: ContextMeasure;
  summaryRequests: number;
  summaryInputTokens: number;
  targetMet: boolean;
  headroomMet: boolean;
  persisted: boolean;
};
export type ContextCommitReceipt = {
  operationId: string;
  sourceRootRevision: string;
  rootRevision: string;
  outcome: "committed" | "commit_unknown";
  persisted: boolean;
  /** The Host reports the final native carrier/enrichments, not just raw summary text. */
  material?: ContextMaterial;
};
export function contextMaintenanceKey(agentId: string, sessionId: string, operationId: string): string {
  return canonicalJson([agentId, sessionId, operationId]);
}
export type ContextMaintenanceRecord = {
  updatedAtMs?: number;
  fingerprint: string;
  identity: ContextMaintenanceIdentity;
  state: "claimed" | "summarizing" | "committing" | "committed" | "failed" | "commit_unknown";
  summaryRequests: number;
  summaryInputTokens: number;
  failure?: ContextFailureCode;
  receipt?: ContextMaintenanceReceipt;
};

function contextObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = cloneJson(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new ContextFailure("context_material_invalid");
  return value;
}
function boundedCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function safeReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
}
export function parseContextBudget(raw: unknown): ContextBudget {
  const v = contextObject(raw, ["policyRevision", "mode", "declaredWindowTokens", "localWindowTokens", "windowTokens", "outputTokens", "reserveTokens", "inputTokens", "preferredTargetTokens", "resumeThresholdTokens", "keepRecentTokens"]);
  if (!safeReference(v.policyRevision) || !/^[a-f0-9]{64}$/.test(v.policyRevision) || !["auto", "manual"].includes(String(v.mode))) throw new ContextFailure("context_policy_invalid");
  for (const key of ["localWindowTokens", "windowTokens", "outputTokens", "reserveTokens", "inputTokens", "preferredTargetTokens", "resumeThresholdTokens", "keepRecentTokens"]) {
    if (!boundedCount(v[key], 16777216)) throw new ContextFailure("context_policy_invalid");
  }
  const b = v as ContextBudget;
  if (b.localWindowTokens < 1024 || b.windowTokens <= 0 || b.outputTokens <= 0 || b.inputTokens <= 0
    || b.windowTokens > b.localWindowTokens || b.reserveTokens < b.outputTokens || b.inputTokens > b.windowTokens - b.reserveTokens
    || b.preferredTargetTokens !== Math.floor(b.inputTokens * 0.60) || b.resumeThresholdTokens !== Math.floor(b.inputTokens * 0.90)
    || b.keepRecentTokens > b.preferredTargetTokens || b.declaredWindowTokens !== null && (!boundedCount(b.declaredWindowTokens) || b.declaredWindowTokens < b.windowTokens)) throw new ContextFailure("context_policy_invalid");
  return b;
}
export function parseContextCandidate(raw: unknown): ContextCandidate {
  const c = contextObject(raw, ["operationId", "sourceRootRevision", "summary", "summarizedRefs", "retainedRefs", "budget"]);
  if (!safeReference(c.operationId) || c.operationId.length > 128 || !safeReference(c.sourceRootRevision)
    || typeof c.summary !== "string" || !c.summary.trim() || c.summary.length > 128 * 1024) throw new ContextFailure("context_material_invalid");
  if (!Array.isArray(c.summarizedRefs) || !Array.isArray(c.retainedRefs)) throw new ContextFailure("context_material_invalid");
  const refs = [...c.summarizedRefs, ...c.retainedRefs];
  if (refs.length > CONTEXT_MAX_MESSAGES || refs.some(ref => !safeReference(ref)) || new Set(refs).size !== refs.length) throw new ContextFailure("context_material_invalid");
  return { operationId: c.operationId, sourceRootRevision: c.sourceRootRevision, summary: c.summary,
    summarizedRefs: c.summarizedRefs as string[], retainedRefs: c.retainedRefs as string[], budget: parseContextBudget(c.budget) };
}
export function parseContextMeasure(raw: unknown): ContextMeasure {
  const m = contextObject(raw, ["method", "meterVersion", "tokens", "estimatedTokens", "uncertaintyTokens", "bytes", "messageCount", "components"]);
  if (!["estimate", "usage-plus-estimate", "tokenizer"].includes(String(m.method)) || !safeReference(m.meterVersion)) throw new ContextFailure("context_material_invalid");
  for (const key of ["tokens", "estimatedTokens", "uncertaintyTokens", "bytes", "messageCount"]) if (!boundedCount(m[key])) throw new ContextFailure("context_material_invalid");
  const c = contextObject(m.components, ["system", "messages", "tools"]);
  if (Object.values(c).some(value => !boundedCount(value)) || Number(m.bytes) > CONTEXT_MATERIAL_MAX_BYTES || Number(m.messageCount) > CONTEXT_MAX_MESSAGES) throw new ContextFailure("context_material_invalid");
  return m as unknown as ContextMeasure;
}
export function parseContextReceipt(raw: unknown): ContextMaintenanceReceipt {
  const r = contextObject(raw, ["operationId", "rootId", "sourceRootRevision", "rootRevision", "outcome", "policyRevision", "budget", "before", "after", "summaryRequests", "summaryInputTokens", "targetMet", "headroomMet", "persisted"]);
  for (const key of ["operationId", "rootId", "sourceRootRevision", "rootRevision", "policyRevision"]) if (!safeReference(r[key])) throw new ContextFailure("context_material_invalid");
  if (!["unchanged", "committed"].includes(String(r.outcome)) || !boundedCount(r.summaryRequests, 64) || !boundedCount(r.summaryInputTokens, 16777216)
    || typeof r.targetMet !== "boolean" || typeof r.headroomMet !== "boolean" || typeof r.persisted !== "boolean") throw new ContextFailure("context_material_invalid");
  const budget = parseContextBudget(r.budget), before = parseContextMeasure(r.before), after = parseContextMeasure(r.after);
  if (r.policyRevision !== budget.policyRevision || r.targetMet !== (after.tokens <= budget.preferredTargetTokens)
    || r.headroomMet !== (after.tokens <= budget.resumeThresholdTokens)) throw new ContextFailure("context_material_invalid");
  return { ...r, budget, before, after } as ContextMaintenanceReceipt;
}

/** Validate untrusted material without cloning/encoding an unbounded entire root.
 * Host metadata remains outside this DTO and is recovered only through source refs. */
export function parseContextMaterial(input: unknown): ContextMaterial {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ContextFailure("context_material_invalid");
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) throw new ContextFailure("context_material_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors);
    if (!["rootId", "rootRevision", "messages", "tools", "options"].every(key => Object.hasOwn(descriptors, key))) throw new ContextFailure("context_material_invalid");
    if (keys.some(key => !["rootId", "rootRevision", "messages", "tools", "options"].includes(key))
      || keys.some(key => !Object.hasOwn(descriptors[key]!, "value"))) throw new ContextFailure("context_material_invalid");
    const raw = input as Record<string, unknown>;
    const boundedRef = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
    if (!boundedRef(raw.rootId) || !boundedRef(raw.rootRevision) || !Array.isArray(raw.messages)
      || raw.messages.length > CONTEXT_MAX_MESSAGES || Object.keys(raw.messages).length !== raw.messages.length) throw new ContextFailure("context_material_invalid");
    const envelope = buildModelEnvelope([], raw.tools, raw.options);
    const messages: ContextSourceMessage[] = [];
    const refs = new Set<string>();
    let bytes = 0;
    for (let i = 0; i < raw.messages.length; i++) {
      const d = Object.getOwnPropertyDescriptor(raw.messages, i);
      if (!d || !Object.hasOwn(d, "value")) throw new ContextFailure("context_material_invalid");
      const row = cloneJson(d.value) as Record<string, unknown>;
      if (!row || Array.isArray(row) || Object.keys(row).some(key => !["ref", "message", "preserve", "summary"].includes(key))
        || !boundedRef(row.ref) || refs.has(row.ref) || (row.preserve !== undefined && typeof row.preserve !== "boolean")
        || (row.summary !== undefined && typeof row.summary !== "boolean")) throw new ContextFailure("context_material_invalid");
      const message = parsePromptMessages([row.message])[0]!;
      const partBytes = estimateContextText(JSON.stringify(message)).bytes;
      bytes += partBytes + 64;
      if (bytes > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
      refs.add(row.ref);
      messages.push({ ref: row.ref, message, ...(row.preserve !== undefined ? { preserve: row.preserve as boolean } : {}),
        ...(row.summary !== undefined ? { summary: row.summary as boolean } : {}) });
    }
    const result = { rootId: raw.rootId, rootRevision: raw.rootRevision, messages, tools: [...envelope.tools], options: { ...envelope.options } };
    measureContext(result);
    return result;
  } catch (error) {
    if (error instanceof ContextFailure) throw error;
    throw new ContextFailure("context_material_invalid");
  }
}

/** Counts code points without allocating a second UTF-8 copy of a giant string.
 * A conservative local heuristic, never reported as exact provider usage. */
export function estimateContextText(text: string): { tokens: number; bytes: number } {
  let units = 0; let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point <= 0x7f) { units += 1; bytes += 1; }
    else if (point <= 0x7ff) { units += 4; bytes += 2; }
    else if (point <= 0xffff) { units += 4; bytes += 3; }
    else { units += 8; bytes += 4; }
    if (bytes > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
  }
  return { tokens: Math.ceil(units / 4), bytes };
}
export function measureContext(material: Pick<ContextMaterial, "messages" | "tools">): ContextMeasure {
  if (material.messages.length > CONTEXT_MAX_MESSAGES || material.tools.length > 128) throw new ContextFailure("context_material_too_large");
  const components = { system: 0, messages: 0, tools: 0 };
  let bytes = 0;
  for (const entry of material.messages) {
    const message = entry.message;
    const value = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const measured = estimateContextText(value);
    let tokens = measured.tokens + 8;
    if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "image") tokens += 4096;
    components[message.role === "system" ? "system" : "messages"] += tokens;
    bytes += measured.bytes + 64;
    if (bytes > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
  }
  const tools = estimateContextText(JSON.stringify(material.tools));
  components.tools = material.tools.length ? tools.tokens + material.tools.length * 12 : 0;
  bytes += tools.bytes;
  if (bytes > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
  const estimatedTokens = components.system + components.messages + components.tools;
  const uncertaintyTokens = Math.ceil(estimatedTokens * 0.10) + 64;
  return { method: "estimate", meterVersion: CONTEXT_METER_VERSION, tokens: estimatedTokens + uncertaintyTokens,
    estimatedTokens, uncertaintyTokens, bytes, messageCount: material.messages.length, components };
}
