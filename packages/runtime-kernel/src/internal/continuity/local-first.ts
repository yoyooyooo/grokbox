import { isContinuityHash, isContinuityUuid } from "./primitives.ts";

/** Finite facts from one native local factory/registrar invocation. No model or
 * execution authority is inferred. Missing historical evidence stays missing. */
export type LocalFirstReceipt = {
  version: 1; operationId: string; localAgentId: string | null; settled: boolean;
  stage: "local-factory" | "registration" | "server-result" | "readback";
  outcome: "registered" | "mismatch" | "unknown";
  source: { sourceSha256: string; transformedSha256: string; profileSha256: string; generationId: string };
  request: { agentId: string; harness: "box"; createCaller: "ensure-server-backed"; createIntent: "register-existing-local";
    introductionSuppressed: boolean; kickstartRequested: boolean } | null;
  firstResponse: { outcome: string; agentId: string | null; serverId: string | null; harness: "box" | "temporal" | null } | null;
  binding: { serverId: string; harness: "box" | "temporal" | null } | null;
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string) => Object.keys(v).sort().join() === names;
const bounded = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x1f]/.test(v);
const harness = (v: unknown) => v === null || v === "box" || v === "temporal";
export function isLocalFirstSource(v: unknown): v is LocalFirstReceipt["source"] {
  return record(v) && keys(v, "generationId,profileSha256,sourceSha256,transformedSha256")
    && [v.sourceSha256, v.transformedSha256, v.profileSha256].every(isContinuityHash) && bounded(v.generationId);
}
export function isLocalFirstReceipt(v: unknown): v is LocalFirstReceipt {
  if (!record(v) || !keys(v, "binding,firstResponse,localAgentId,operationId,outcome,request,settled,source,stage,version")
    || v.version !== 1 || !isContinuityUuid(v.operationId) || !(v.localAgentId === null || isContinuityUuid(v.localAgentId))
    || typeof v.settled !== "boolean" || !["local-factory", "registration", "server-result", "readback"].includes(String(v.stage))
    || !["registered", "mismatch", "unknown"].includes(String(v.outcome))) return false;
  const s = v.source, q = v.request, r = v.firstResponse, b = v.binding;
  if (!isLocalFirstSource(s)) return false;
  if (q !== null && (!record(q) || !keys(q, "agentId,createCaller,createIntent,harness,introductionSuppressed,kickstartRequested")
    || q.agentId !== v.localAgentId || !isContinuityUuid(q.agentId) || q.harness !== "box" || q.createCaller !== "ensure-server-backed"
    || q.createIntent !== "register-existing-local" || typeof q.introductionSuppressed !== "boolean" || typeof q.kickstartRequested !== "boolean")) return false;
  if (r !== null && (!record(r) || !keys(r, "agentId,harness,outcome,serverId") || !bounded(r.outcome)
    || !(r.agentId === null || isContinuityUuid(r.agentId)) || !(r.serverId === null || bounded(r.serverId)) || !harness(r.harness) || q === null)) return false;
  if (b !== null && (!record(b) || !keys(b, "harness,serverId") || !bounded(b.serverId) || !harness(b.harness) || r === null)) return false;
  if (v.outcome === "registered" && (v.settled !== true || v.stage !== "readback" || !record(q) || !record(r) || !record(b)
    || r.agentId !== v.localAgentId || r.harness !== "box" || b.harness !== "box" || r.serverId !== b.serverId)) return false;
  return true;
}
