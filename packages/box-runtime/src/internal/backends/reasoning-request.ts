import { BackendFailure, annotateStreamFailure } from "@grokbox/runtime-kernel/contract";
import { parseReasoningPolicy, type ReasoningPolicy } from "@grokbox/runtime-kernel/selection";
import type { OpenaiPromptApi } from "./openai-prompt-adapter.ts";

function reject(): never {
  throw annotateStreamFailure(new BackendFailure("unsupported_options"), {
    normalizeCause: "reasoning_request_conflict", rejectSite: "provider_request",
  });
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pure and whitelist-only: never spoof model IDs, change API, alter budgets,
 * expose a generic body override or trust SDK name heuristics. Runs before HTTP. */
export function encodeReasoningRequest(init: RequestInit | undefined, api: OpenaiPromptApi,
  model: string, policy: ReasoningPolicy | undefined): RequestInit {
  try { parseReasoningPolicy(policy); } catch { return reject(); }
  if (typeof init?.body !== "string") return reject();
  let body: Record<string, unknown>;
  try { const raw: unknown = JSON.parse(init.body); if (!object(raw)) return reject(); body = raw; }
  catch { return reject(); }
  if (body.model !== model) return reject();
  // Null, foreign-protocol fields and conflicting values are not silently fixed.
  if (api === "responses" && Object.hasOwn(body, "reasoning_effort")) return reject();
  if (api === "chat" && Object.hasOwn(body, "reasoning")) return reject();
  if (Object.hasOwn(body, "reasoning") && !object(body.reasoning)) return reject();
  const previous = api === "responses" ? (body.reasoning as Record<string, unknown> | undefined)?.effort : body.reasoning_effort;
  const present = api === "responses" ? object(body.reasoning) && Object.hasOwn(body.reasoning, "effort") : Object.hasOwn(body, "reasoning_effort");
  if (!policy) {
    if (present) return reject();
    return init; // Provider default: exact no-override bytes, no synthetic medium/none.
  }
  if (present && previous !== policy.effort) return reject();
  if (api === "responses") body.reasoning = { ...(body.reasoning as Record<string, unknown> | undefined), effort: policy.effort };
  else body.reasoning_effort = policy.effort;
  const encoded = JSON.stringify(body);
  const verified = JSON.parse(encoded);
  if ((api === "responses" ? verified.reasoning?.effort : verified.reasoning_effort) !== policy.effort) return reject();
  return { ...init, body: encoded };
}
