import { projectProviderRecoveryState, type ProviderRecoveryState } from "./provider-recovery.ts";
import { presentAuthorityFailure } from "./authority-presentation.ts";
import { BACKEND_FAILURE_CODES } from "./events.ts";
import { BINDING_FAILURE_CODES } from "./binding.ts";
import { projectStreamDiagnostic, type StreamDiagnostic } from "./stream-diagnostic.ts";
import { observationOwn as own, projectProviderHttp, type ProviderHttpObservation } from "./provider-observation.ts";

export const FAILURE_SUMMARY_VERSION = 1 as const;
export const FAILURE_CLASSIFIER_VERSION = "failure-facts-v1" as const;
export const FAILURE_PHASES = ["admission", "prepare", "auth", "sdk", "provider", "normalize", "authority", "transport", "internal", "complete"] as const;
export type FailurePhase = typeof FAILURE_PHASES[number];
export const PROVIDER_ERROR_CODES = ["invalid_request_error", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "model_not_found", "unsupported_parameter", "missing_required_parameter", "invalid_value", "context_length_exceeded", "context_window_exceeded", "prompt_too_long", "request_too_large"] as const;
export const PROVIDER_ERROR_PARAMS = ["model", "instructions", "input", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "temperature", "top_p", "max_tokens", "max_output_tokens", "reasoning", "store"] as const;
export const FAILURE_FACT_REASONS = ["unknown", "validation", "auth", "transport", "http", "sdk_validation", "sdk_no_output", "stream_shape", "output_limit", "content_filter", "provider_resource", "provider_interrupted", "stream_budget", "authority_check"] as const;
const CODES = [...BACKEND_FAILURE_CODES, ...BINDING_FAILURE_CODES, "invalid_stream", "model_error", "parallel_tools", "timeout", "unsupported_version", "malformed_frame", "unknown_method", "extra_keys", "busy", "disconnected", "transport_error", "defect", "interrupted", "unknown"] as const;
export const FAILURE_CATEGORIES = ["upstream_http", "upstream_auth", "upstream_rate_limit", "upstream_quota", "upstream_transport", "upstream_interrupted", "output_limit", "content_filter", "stream_invalid", "stream_budget", "local_capacity", "local_transport", "execution_history", "authority", "wire", "configuration", "cancelled", "unknown"] as const;
export type FailureCategory = typeof FAILURE_CATEGORIES[number];
export type FailureIdentity = { agentId: string; turnId: string; stepId: string; hostGenerationId: string; serviceEpoch: string; bindingId?: string };
export type FailureSummary = {
  version: 1;
  classifierVersion: typeof FAILURE_CLASSIFIER_VERSION;
  failureId?: string;
  code: typeof CODES[number];
  phase: FailurePhase;
  reason?: typeof FAILURE_FACT_REASONS[number];
  category: FailureCategory;
  origin: "upstream" | "runtime" | "unknown";
  http?: ProviderHttpObservation;
  providerCode?: typeof PROVIDER_ERROR_CODES[number];
  providerParam?: typeof PROVIDER_ERROR_PARAMS[number];
  diagnostic?: StreamDiagnostic;
  identity?: FailureIdentity;
  progress?: { canonicalEvents: number; backendAttempts: number };
  recovery?: ProviderRecoveryState;
};
function member<T extends string>(value: unknown, values: readonly T[]): T | undefined { return typeof value === "string" && values.includes(value as T) ? value as T : undefined; }
export function failureFactId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value); }
const uint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function classifyFailure(input: { code: string; phase: FailurePhase; reason?: string; http?: ProviderHttpObservation; providerCode?: string }): Pick<FailureSummary, "category" | "origin"> {
  const { code, phase, reason, http, providerCode } = input;
  // Specific local checks must not be relabelled by unrelated HTTP metadata.
  if (code === "not_admitted" || phase === "authority") return { category: "authority", origin: "runtime" };
  if (code === "ledger_unavailable") return { category: "execution_history", origin: "runtime" };
  if (code === "capacity" || code === "turn_busy") return { category: "local_capacity", origin: "runtime" };
  if (code === "stream_limit") return { category: "stream_budget", origin: "runtime" };
  if (code === "stream_invalid" || code === "invalid_stream" || code === "parallel_tools") return { category: "stream_invalid", origin: "runtime" };
  if (["unsupported_version", "service_epoch_mismatch", "malformed_frame", "extra_keys"].includes(code)) return { category: "wire", origin: "runtime" };
  if (code === "cancelled" || code === "interrupted") return { category: "cancelled", origin: "runtime" };
  if (code === "transport_error" || code === "disconnected") return { category: "local_transport", origin: "runtime" };
  if (http && http.status >= 400) {
    const category: FailureCategory = providerCode === "insufficient_quota" ? "upstream_quota"
      : providerCode === "rate_limit_exceeded" || http.status === 429 ? "upstream_rate_limit"
      : http.status === 401 || http.status === 403 ? "upstream_auth" : "upstream_http";
    return { category, origin: "upstream" };
  }
  if (reason === "output_limit") return { category: "output_limit", origin: "upstream" };
  if (reason === "content_filter") return { category: "content_filter", origin: "upstream" };
  if (reason === "provider_resource" || reason === "provider_interrupted") return { category: "upstream_interrupted", origin: "upstream" };
  if (phase === "provider" && reason === "transport") return { category: "upstream_transport", origin: "upstream" };
  if (phase === "prepare" || phase === "auth" || phase === "admission") return { category: "configuration", origin: "runtime" };
  return { category: "unknown", origin: "unknown" };
}
/** Shared safety projection. Derive category from facts rather than accepting a
 * sender's preformatted message or an arbitrary classification string. */
export function projectFailureSummary(value: unknown): FailureSummary | undefined {
  try {
    if (own(value, "version") !== FAILURE_SUMMARY_VERSION) return undefined;
    const code = member(own(value, "code"), CODES), phase = member(own(value, "phase"), FAILURE_PHASES);
    if (!code || !phase) return undefined;
    const reason = member(own(value, "reason"), FAILURE_FACT_REASONS);
    const http = projectProviderHttp(own(value, "http"));
    const providerCode = member(own(value, "providerCode"), PROVIDER_ERROR_CODES), providerParam = member(own(value, "providerParam"), PROVIDER_ERROR_PARAMS);
    const diagnostic = projectStreamDiagnostic(own(value, "diagnostic"));
    const failureId = own(value, "failureId");
    const out: FailureSummary = { version: 1, classifierVersion: FAILURE_CLASSIFIER_VERSION, code, phase,
      ...classifyFailure({ code, phase, reason, http, providerCode }), ...(reason ? { reason } : {}),
      ...(http ? { http } : {}), ...(providerCode ? { providerCode } : {}), ...(providerParam ? { providerParam } : {}),
      ...(diagnostic ? { diagnostic } : {}), ...(failureFactId(failureId) ? { failureId } : {}) };
    const rawIdentity = own(value, "identity");
    if (rawIdentity !== undefined) {
      const identity: Record<string, string> = {};
      for (const key of ["agentId", "turnId", "stepId", "hostGenerationId", "serviceEpoch"]) {
        const id = own(rawIdentity, key); if (!failureFactId(id)) return undefined; identity[key] = id;
      }
      const binding = own(rawIdentity, "bindingId");
      if (binding !== undefined) { if (!failureFactId(binding)) return undefined; identity.bindingId = binding; }
      out.identity = identity as FailureIdentity;
    }
    const progress = own(value, "progress"), canonicalEvents = own(progress, "canonicalEvents"), backendAttempts = own(progress, "backendAttempts");
    if (uint(canonicalEvents) && uint(backendAttempts)) out.progress = { canonicalEvents, backendAttempts };
    const recovery = projectProviderRecoveryState(own(value,"recovery")); if(recovery)out.recovery=recovery;
    return out;
  } catch { return undefined; }
}
/** Decode legacy journal evidence using the same classifier as live v5 frames. */
export function failureSummaryFromObservation(value: unknown): FailureSummary | undefined {
  const diagnostic = own(value, "diagnostic");
  const existing = projectFailureSummary(own(value, "failureSummary"));
  if (existing) {
    // Safe shape is not sufficient identity proof. Legacy Host records can carry
    // a backend code alias, but an explicit execution tuple must never disagree.
    const keys = ["agentId", "turnId", "stepId", "hostGenerationId", "serviceEpoch"] as const;
    const bound = existing.identity;
    if (!bound || keys.every(key => own(value, key) === undefined || own(value, key) === bound[key])) return existing;
  }
  const detail = projectStreamDiagnostic(diagnostic);
  const http = detail?.stream?.http ?? projectProviderHttp({ status: own(diagnostic, "httpStatus") ?? detail?.stream?.providerHttpStatus });
  return projectFailureSummary({ version: 1,
    code: own(value, "failureCode") ?? own(value, "errorCode") ?? "unknown",
    phase: own(value, "phase") ?? (own(value, "stage") === "admit" ? "admission" : own(value, "stage")) ?? "internal",
    reason: own(diagnostic, "reason"), http, providerCode: own(diagnostic, "providerCode"), providerParam: own(diagnostic, "providerParam"),
    diagnostic: detail, failureId: own(value, "failureId"),
    progress: { canonicalEvents: own(value, "eventCount"), backendAttempts: own(value, "backendAttempts") } });
}
export function failureSummaryMatches(summary: FailureSummary, identity: Partial<FailureIdentity>, code: string): boolean {
  if (summary.code !== code || !summary.identity) return false;
  return Object.entries(identity).every(([key, value]) => value === undefined || summary.identity?.[key as keyof FailureIdentity] === value);
}
const summaries = new WeakMap<object, FailureSummary>();
export function annotateFailureSummary<T extends object>(error: T, value: unknown): T {
  const summary = projectFailureSummary(value); if (summary) summaries.set(error, summary); return error;
}
export function failureSummaryOf(error: unknown): FailureSummary | undefined {
  return error !== null && typeof error === "object" ? projectFailureSummary(summaries.get(error)) : undefined;
}
export function presentFailure(summary: FailureSummary, host: { receivedOutput?: boolean; toolsReleased?: number } = {}) {
  const status = summary.http?.status;
  const authorityPresentation = presentAuthorityFailure(summary.diagnostic?.authority, summary.identity);
  const text: Record<FailureCategory, string> = {
    upstream_http: `The upstream model endpoint returned HTTP ${status ?? "error"}.`,
    upstream_auth: `The upstream model endpoint rejected authentication or access (HTTP ${status}).`,
    upstream_rate_limit: `The upstream model endpoint rate-limited this request${status ? ` (HTTP ${status})` : ""}.`,
    upstream_quota: "The upstream model endpoint reported insufficient quota.",
    upstream_transport: "The connection to the upstream model endpoint failed or its response was interrupted.",
    upstream_interrupted: "The upstream model endpoint ended generation without completing the requested output.",
    output_limit: "The upstream model output reached its generation limit before completion.",
    content_filter: "The upstream model endpoint stopped generation under its content policy.",
    stream_invalid: summary.diagnostic?.normalizeCause === "undeclared_tool" ? "The model returned a tool name that was not declared for this STEP."
      : summary.diagnostic?.normalizeCause === "tool_declaration_mismatch" ? "The encoded provider tool declarations did not match this STEP; the request was stopped before dispatch."
      : summary.diagnostic?.normalizeCause === "tool_identity_conflict" ? "The model stream changed a tool identity before completion."
      : summary.diagnostic?.normalizeCause === "sdk_schema_mismatch" ? "The provider stream contained a field shape rejected by the SDK protocol schema."
      : summary.diagnostic?.normalizeCause === "unsupported_provider_state" ? "The provider returned reasoning state incompatible with the selected inline Chat dialect."
      : summary.diagnostic?.normalizeCause === "unterminated_reasoning" ? "The provider did not close its inline reasoning block before a tool call or completion."
      : summary.diagnostic?.normalizeCause === "missing_finish" ? "The model stream ended without a valid completion reason."
      : summary.diagnostic?.normalizeCause === "unsupported_finish_reason" ? "The model stream ended with an unsupported completion reason."
      : summary.diagnostic?.normalizeCause?.startsWith("tool_arguments") || summary.diagnostic?.normalizeCause === "open_tools_at_finish" ? "The model stream did not provide a valid, complete tool call."
      : "The model output failed stream-integrity validation.",
    stream_budget: summary.diagnostic?.budget
      ? `The model output exceeded the local ${summary.diagnostic.budget.layer} ${summary.diagnostic.budget.metric} budget (${summary.diagnostic.budget.measured} observed; ${summary.diagnostic.budget.limit} allowed).`
      : "The model output exceeded a local resource budget and was stopped.",
    local_capacity: "The local model runtime could not admit this work with its currently available resources.",
    local_transport: "The connection between the local Host and model runtime failed or closed before completion.",
    execution_history: "The local execution history could not be read or saved safely.",
    authority: authorityPresentation.message,
    wire: summary.code === "unsupported_version" ? "The local Host and model runtime use incompatible protocol versions. Update them together."
      : "The local Host and model runtime could not validate their execution protocol.",
    configuration: "The local model configuration or request could not be admitted safely.",
    cancelled: "This model request was cancelled.",
    unknown: "The model request failed; the available evidence does not identify a more specific cause.",
  };
  const bits = [text[summary.category]];
  const authority = summary.category === "authority" ? summary.diagnostic?.authority : undefined;
  if (authority?.ownershipRead?.errorCode) bits.push(`Ownership-read detail: ${authority.ownershipRead.errorCode}${authority.ownershipRead.phase ? ` (phase=${authority.ownershipRead.phase})` : ""}.`);
  if (authority?.readRecovery && authority.readRecovery.attempts > 1) bits.push(`${authority.readRecovery.attempts} bounded ownership-read attempts were made within this STEP; no model request was replayed by that recovery.`);
  if (authority?.checkpoint) bits.push(`Authority checkpoint: ${authority.checkpoint}${authority.durationMs !== undefined ? ` (${authority.durationMs} ms)` : ""}.`);
  if (authority?.evidenceAgeMs !== undefined) bits.push(`Evidence age: ${authority.evidenceAgeMs} ms.`);
  if (summary.category === "authority") bits.push(`Inspect evidence: ${authorityPresentation.next}.`);
  if (summary.progress?.backendAttempts === 0) bits.push("No model request was dispatched by this STEP.");
  if (host.receivedOutput === false) bits.push("No model output was received by this STEP.");
  else if (host.receivedOutput === true && summary.category === "upstream_transport") bits.push("Some output was received before the interruption.");
  if (host.toolsReleased === 0) {
    bits.push("No tools were released by this STEP.");
    if (summary.diagnostic?.normalizeCause === "undeclared_tool") bits.push("Earlier STEPs may already have changed state; reconcile before replaying the task.");
  }
  else if (host.toolsReleased !== undefined && host.toolsReleased > 0) bits.push("Tools had already been released; do not replay the whole task automatically.");
  if (summary.progress?.backendAttempts === 1) bits.push("No automatic retry was made.");
  else if (summary.progress && summary.progress.backendAttempts > 1) bits.push(`${summary.progress.backendAttempts} model attempts were made.`);
  if (summary.recovery?.phase === "waiting") bits.push("The local runtime is waiting before a permitted model-only retry.");
  if (summary.recovery?.outcomeUncertain && summary.recovery.attempts.length > 1) bits.push("Earlier upstream execution or billing may have occurred.");
  bits.push("No fallback model was used.");
  const action = ["upstream_auth", "upstream_quota"].includes(summary.category) ? "check_provider_access"
    : summary.category.startsWith("upstream") ? "check_upstream_route"
    : summary.category === "wire" ? "align_local_components" : summary.category === "authority" ? authorityPresentation.action
    : summary.category === "stream_invalid" ? "inspect_stream_evidence" : "inspect_incident";
  return { version: 1 as const, templateId: summary.category, classifierVersion: FAILURE_CLASSIFIER_VERSION,
    message: bits.join(" "), action, ...(summary.category === "authority" ? { next: authorityPresentation.next } : {}), replayAuthorized: false as const };
}
