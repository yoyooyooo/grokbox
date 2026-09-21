import { botIdFromRef, botRef, UUID, ManagementClientError } from "./contract.ts";
import { parseContextBudget, parseContextManualApproval, CONTEXT_FAILURE_CODES, type ContextFailureCode, type ContextBudget, type ContextManualApproval } from "@grokbox/runtime-kernel/compaction";

export type CompactionPreview = {
  botRef: string; scopeId: string; revision: string; approval: ContextManualApproval;
  modelId: string; budget: ContextBudget; nativeCapability: "ready" | "busy" | "blocked" | "unavailable";
  observedAtMs: number; rootSelection: "current-at-dispatch"; contentIncluded: false; mayCallModel: true; startsTask: false;
};
export type CompactionChange = { requestId: string; botRef: string; scopeId: string; expectedRevision: string; confirmed: true };
export type CompactionContinuation = { requestId: string; botRef: string; scopeId: string; action: "reconcile" | "resume" | "cancel"; confirmed: true };
export type CompactionResult = { outcome: "unchanged" | "committed"; receiptDigest: string; sourceRevisionDigest: string; revisionDigest: string;
  policyRevision: string; beforeTokens: number; afterTokens: number; summaryRequests: number; summaryInputTokens: number;
  targetMet: boolean; headroomMet: boolean; persisted: boolean };
export type CompactionOperation = { requestId: string; operationRef: string; botRef: string; scopeId: string; expectedRevision: string;
  state: "admitted" | "unknown" | "completed" | "failed" | "cancelled"; result: CompactionResult | null; failureCode: ContextFailureCode | null; createdAtMs: number;
  nativeSettlement: "not-dispatched" | "not-observed" | "returned"; currentRoot: "not-observed"; startedTask: false; contentIncluded: false };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Reflect.ownKeys(v).every(key => typeof key === "string" && "value" in Object.getOwnPropertyDescriptor(v, key)!);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const bad = (): never => { throw new ManagementClientError("invalid_input", "Use the exact compaction Bot, account, preview revision and original request UUID."); };
export const compactionOperationRef = (installationId: string, scopeId: string, requestId: string) => `compaction-operation:${installationId}:${scopeId}:${requestId}`;
export function compactionOperationIdentity(ref: string, installationId: string) {
  const parts = ref.split(":");
  if (parts.length !== 4 || parts[0] !== "compaction-operation" || !UUID.test(parts[1]!) || !hash(parts[2]) || !UUID.test(parts[3]!)) return bad();
  if (parts[1] !== installationId) throw new ManagementClientError("wrong_installation", "The compaction operation belongs to another installation.");
  return { scopeId: parts[2]!, requestId: parts[3]!, ref };
}
export function normalizeCompactionChange(v: unknown, installationId: string): CompactionChange {
  if (!object(v) || !exact(v, ["requestId", "botRef", "scopeId", "expectedRevision", "confirmed"]) || typeof v.requestId !== "string" || !UUID.test(v.requestId)
    || typeof v.botRef !== "string" || !hash(v.scopeId) || !hash(v.expectedRevision) || v.confirmed !== true) return bad();
  return { requestId: v.requestId.toLowerCase(), botRef: botRef(installationId, botIdFromRef(v.botRef, installationId)), scopeId: v.scopeId, expectedRevision: v.expectedRevision, confirmed: true };
}
export function normalizeCompactionContinuation(v: unknown, installationId: string): CompactionContinuation {
  if (!object(v) || !exact(v, ["requestId", "botRef", "scopeId", "action", "confirmed"]) || typeof v.action !== "string" || !["reconcile", "resume", "cancel"].includes(v.action)) return bad();
  const { expectedRevision: _, ...common } = normalizeCompactionChange({ requestId: v.requestId, botRef: v.botRef, scopeId: v.scopeId, expectedRevision: "0".repeat(64), confirmed: v.confirmed }, installationId);
  return { ...common, action: v.action as CompactionContinuation["action"] };
}
export function compactionResult(v: unknown): v is CompactionResult {
  return object(v) && exact(v, ["outcome", "receiptDigest", "sourceRevisionDigest", "revisionDigest", "policyRevision", "beforeTokens", "afterTokens", "summaryRequests", "summaryInputTokens", "targetMet", "headroomMet", "persisted"])
    && ["unchanged", "committed"].includes(String(v.outcome)) && [v.receiptDigest, v.sourceRevisionDigest, v.revisionDigest, v.policyRevision].every(hash)
    && [v.beforeTokens, v.afterTokens, v.summaryRequests, v.summaryInputTokens].every(count) && Number(v.summaryRequests) <= 64 && Number(v.summaryInputTokens) <= 16777216
    && typeof v.targetMet === "boolean" && typeof v.headroomMet === "boolean" && typeof v.persisted === "boolean" && (v.outcome === "committed") === v.persisted;
}
export function compactionPreview(v: unknown, installationId: string, target: string): v is CompactionPreview {
  try {
    if (!object(v) || !exact(v, ["botRef", "scopeId", "revision", "approval", "modelId", "budget", "nativeCapability", "observedAtMs", "rootSelection", "contentIncluded", "mayCallModel", "startsTask"])) return false;
    const approval = parseContextManualApproval(v.approval), budget = parseContextBudget(v.budget), id = botIdFromRef(target, installationId);
    return v.botRef === botRef(installationId, id) && v.scopeId === approval.scopeId && hash(v.revision)
      && typeof v.modelId === "string" && v.modelId.length > 0 && v.modelId.length <= 256 && !/[\x00-\x1f]/.test(v.modelId)
      && budget.policyRevision === approval.policyRevision && ["ready", "busy", "blocked", "unavailable"].includes(String(v.nativeCapability))
      && count(v.observedAtMs) && v.observedAtMs > 0 && v.rootSelection === "current-at-dispatch" && v.contentIncluded === false && v.mayCallModel === true && v.startsTask === false;
  } catch { return false; }
}
export function compactionOperation(v: unknown, installationId: string, scopeId: string, requestId: string): v is CompactionOperation {
  try {
    if (!object(v) || !exact(v, ["requestId", "operationRef", "botRef", "scopeId", "expectedRevision", "state", "result", "failureCode", "createdAtMs", "nativeSettlement", "currentRoot", "startedTask", "contentIncluded"])) return false;
    const id = botIdFromRef(String(v.botRef), installationId);
    return UUID.test(requestId) && hash(scopeId) && v.requestId === requestId && v.scopeId === scopeId && v.botRef === botRef(installationId, id)
      && v.operationRef === compactionOperationRef(installationId, scopeId, requestId) && hash(v.expectedRevision)
      && ["admitted", "unknown", "completed", "failed", "cancelled"].includes(String(v.state)) && (v.state === "completed" ? compactionResult(v.result) && v.nativeSettlement === "returned" : v.result === null)
      && (v.state === "failed" ? typeof v.failureCode === "string" && (CONTEXT_FAILURE_CODES as readonly string[]).includes(v.failureCode)
        && !["commit_unknown", "native_cleanup_unknown"].includes(v.failureCode) && v.nativeSettlement === "returned" : v.failureCode === null)
      && (v.state === "admitted" || v.state === "cancelled" ? v.nativeSettlement === "not-dispatched" : v.state === "unknown" ? v.nativeSettlement === "not-observed" : true)
      && count(v.createdAtMs) && v.createdAtMs > 0 && v.currentRoot === "not-observed" && v.startedTask === false && v.contentIncluded === false;
  } catch { return false; }
}
