import { ModelManagementError } from "./model-management-error.ts";

export const MODEL_PROBE_LIMITS = Object.freeze({ maxRequests: 1, maxOutputTokens: 32, maxResponseBytes: 65536, defaultTimeoutMs: 10000, maxTimeoutMs: 30000 });
export type ModelProbeRequest = { requestId: string; modelId: string; expectedRevision: string; confirmed: true; timeoutMs: number };
export type ModelProbeReceipt = {
  version: 1; operationRef: string; requestId: string; modelId: string; modelRevision: string;
  state: "succeeded" | "failed" | "unknown"; reason: "completed" | "not-dispatched" | "outcome-unknown";
  acceptedAt: string; finishedAt: string | null;
  providerRequestSent: boolean | null;
  outputBytes: number;
  usage: { promptTokens: number; completionTokens: number } | null;
  cost: { mayIncur: boolean; amount: "unknown" | "none"; maxRequests: 1; requestedMaxOutputTokens: 32 };
  toolsExecuted: false; responseStored: false; retryAllowed: false;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export function modelProbeRequestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function invalid() { return new ModelManagementError("invalid_input", "A model probe requires an exact model, observed revision, persisted request UUID and explicit cost confirmation."); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
export function normalizeModelProbe(input: unknown): ModelProbeRequest {
  const value = object(input, ["requestId", "modelId", "expectedRevision", "confirmed", "timeoutMs"]);
  if (typeof value.modelId !== "string" || !ID.test(value.modelId) || typeof value.expectedRevision !== "string"
    || !HASH.test(value.expectedRevision) || value.confirmed !== true) throw invalid();
  const timeoutMs = value.timeoutMs ?? MODEL_PROBE_LIMITS.defaultTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MODEL_PROBE_LIMITS.maxTimeoutMs) throw invalid();
  return { requestId: modelProbeRequestId(value.requestId), modelId: value.modelId, expectedRevision: value.expectedRevision, confirmed: true, timeoutMs };
}
export function parseModelProbeReceipt(input: unknown): ModelProbeReceipt {
  const value = object(input, ["version", "operationRef", "requestId", "modelId", "modelRevision", "state", "reason", "acceptedAt", "finishedAt",
    "providerRequestSent", "outputBytes", "usage", "cost", "toolsExecuted", "responseStored", "retryAllowed"]);
  if (value.version !== 1 || typeof value.operationRef !== "string" || !/^model-probe:[0-9a-f-]{36}:[a-f0-9]{64}$/.test(value.operationRef)
    || typeof value.requestId !== "string" || modelProbeRequestId(value.requestId) !== value.requestId
    || typeof value.modelId !== "string" || !ID.test(value.modelId) || typeof value.modelRevision !== "string" || !HASH.test(value.modelRevision)
    || typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt))
    || !(value.finishedAt === null || typeof value.finishedAt === "string" && Number.isFinite(Date.parse(value.finishedAt)))
    || !(value.providerRequestSent === null || typeof value.providerRequestSent === "boolean")
    || typeof value.outputBytes !== "number" || !Number.isSafeInteger(value.outputBytes) || value.outputBytes < 0 || value.outputBytes > MODEL_PROBE_LIMITS.maxResponseBytes
    || value.toolsExecuted !== false || value.responseStored !== false || value.retryAllowed !== false) throw invalid();
  if (!((value.state === "succeeded" && value.reason === "completed" && value.finishedAt !== null && value.providerRequestSent !== null)
    || (value.state === "failed" && value.reason === "not-dispatched" && value.providerRequestSent === false && value.finishedAt !== null)
    || (value.state === "unknown" && value.reason === "outcome-unknown"))) throw invalid();
  if (value.usage !== null) {
    const usage = object(value.usage, ["promptTokens", "completionTokens"]);
    for (const key of ["promptTokens", "completionTokens"]) if (typeof usage[key] !== "number" || !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) throw invalid();
  }
  const cost = object(value.cost, ["mayIncur", "amount", "maxRequests", "requestedMaxOutputTokens"]);
  if (typeof cost.mayIncur !== "boolean" || !["unknown", "none"].includes(String(cost.amount))
    || cost.mayIncur !== (cost.amount === "unknown") || cost.maxRequests !== 1 || cost.requestedMaxOutputTokens !== 32) throw invalid();
  return structuredClone(value) as ModelProbeReceipt;
}
