import { BoxRuntimeError } from "../contract/errors.ts";

/** Wire effort values, not reasoning visibility, token budgets or Pi UI levels. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ReasoningPolicy = { effort: ReasoningEffort };
/** Absent = unknown. This declaration is not a live Provider attestation. */
export type ReasoningCapability = false | { efforts: ReasoningEffort[] };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && REASONING_EFFORTS.includes(v as ReasoningEffort);
}
function invalid(message: string, failureCode = "reasoning_effort_invalid"): never {
  throw new BoxRuntimeError("invalid_usage", message, { failureCode });
}
export function parseReasoningPolicy(value: unknown): ReasoningPolicy | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(k => k !== "effort") || !isReasoningEffort(value.effort)) {
    return invalid("reasoning must contain exactly one supported effort value; omit it for the provider default.");
  }
  return { effort: value.effort };
}
export function parseRequestedEffort(value: unknown): ReasoningPolicy | undefined {
  if (value === undefined || value === "default") return undefined;
  if (!isReasoningEffort(value)) return invalid("--effort must be default, none, minimal, low, medium, high, xhigh, or max; the model must support it.");
  return { effort: value };
}
export function parseReasoningCapability(value: unknown): ReasoningCapability | undefined {
  if (value === undefined || value === false) return value;
  if (!object(value) || Object.keys(value).some(k => k !== "efforts") || !Array.isArray(value.efforts)
    || value.efforts.length === 0 || value.efforts.length > REASONING_EFFORTS.length
    || !value.efforts.every(isReasoningEffort) || new Set(value.efforts).size !== value.efforts.length) {
    return invalid("capabilities.reasoning must be false or a nonempty unique efforts whitelist.", "reasoning_capability_invalid");
  }
  // Declaration order must not change a selection's identity.
  const efforts = value.efforts;
  return { efforts: REASONING_EFFORTS.filter(e => efforts.includes(e)) };
}
export function assertReasoningSupported(model: {
  provider: string; capabilities: { reasoning?: ReasoningCapability };
}, policy: ReasoningPolicy | undefined): void {
  if (!policy) return;
  parseReasoningPolicy(policy);
  if (!["openai", "openai-chat", "openai-responses"].includes(model.provider)) {
    invalid("This backend does not support an explicit reasoning effort.", "reasoning_effort_unsupported");
  }
  const capability = parseReasoningCapability(model.capabilities.reasoning);
  if (capability === undefined) {
    invalid("This model channel has no qualified effort whitelist. Declare its capabilities before selecting an effort; no setting was saved.", "reasoning_capability_unknown");
  }
  if (capability === false || !capability.efforts.includes(policy.effort)) {
    invalid("The requested effort is not supported by this model channel; no downgrade or channel switch is allowed.", "reasoning_effort_unsupported");
  }
}

/** Only explicit, identity-mapped wire efforts qualify. A reasoning boolean,
 * numeric thinking budget or lossy high -> medium mapping proves no whitelist. */
export function piReasoningCapability(row: Record<string, unknown>): ReasoningCapability | undefined {
  if (row.reasoning === false) return false;
  const map = row.thinkingLevelMap;
  if (!object(map)) return undefined;
  const efforts = REASONING_EFFORTS.filter(e => map[e] === e || e === "none" && map.off === "none");
  return efforts.length ? { efforts } : undefined;
}
