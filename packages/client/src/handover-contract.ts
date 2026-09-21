import { UUID, ManagementClientError } from "./contract.ts";
import { protectionReferenceIdentity } from "./protection-contract.ts";

export const HANDOVER_ACTIONS = ["advance", "observe", "attest", "retire"] as const;
export type HandoverAction = typeof HANDOVER_ACTIONS[number];
export type HandoverChange = { requestId: string; handoverRef: string; action: HandoverAction; expectedRevision: string; confirmed: true;
  itemId?: string; evidenceRef?: string };
export type HandoverContinuation = { requestId: string; scopeId: string; action: "resume" | "reconcile" | "cancel"; confirmed: true };
export type HandoverAssessment = { evidenceHash: string; observedAtMs: number; healthySinceMs: number | null; lastActivityAtMs: number | null;
  newMessages: number; coverage: "complete" | "partial"; gap: boolean; eligible: boolean; automaticDeleteAuthorized: boolean; blockers: string[] };
export type HandoverObservedDuty = { itemId: string; inputDigest: string; state: "complete" | "unknown" | "unsupported" | "not_dispatched";
  evidenceHash: string | null; evidenceRef: string | null };
export type HandoverResult = { outcome: "advanced" | "observed" | "attested" | "blocked" | "retired"; reason: string | null; revision: string;
  remaining: number; unknown: number; complete: number; assessment: HandoverAssessment | null;
  observations: HandoverObservedDuty[]; observationsTruncated: boolean; sourceDeleted: boolean; allDutiesComplete: false };
export type HandoverOperation = { requestId: string; operationRef: string; handoverRef: string; action: HandoverAction; expectedRevision: string;
  state: "admitted" | "unknown" | "completed" | "cancelled"; result: HandoverResult | null; createdAtMs: number; privateInputsIncluded: false };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Reflect.ownKeys(v).every(k => typeof k === "string" && "value" in Object.getOwnPropertyDescriptor(v, k)!);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
const bad = (): never => { throw new ManagementClientError("invalid_input", "Use the exact handover, reviewed revision and original request; evidence must reference a retained observation."); };
export const handoverOperationRef = (installation: string, scope: string, request: string) => `handover-operation:${installation}:${scope}:${request}`;
export function handoverOperationIdentity(ref: string, installation: string) {
  const p = ref.split(":");
  if (p.length !== 4 || p[0] !== "handover-operation" || !UUID.test(p[1]!) || !hash(p[2]) || !UUID.test(p[3]!)) return bad();
  if (p[1] !== installation) throw new ManagementClientError("wrong_installation", "This handover request belongs to another installation.");
  return { scopeId: p[2]!, requestId: p[3]!, ref };
}
export const handoverEvidenceRef = (installation: string, scope: string, request: string, itemId: string, digest: string) => `handover-evidence:${installation}:${scope}:${request}:${itemId}:${digest}`;
export function handoverEvidenceIdentity(ref: string, installation: string) {
  const p = ref.split(":");
  if (p.length !== 6 || p[0] !== "handover-evidence" || !UUID.test(p[1]!) || !hash(p[2]) || !UUID.test(p[3]!) || !UUID.test(p[4]!) || !hash(p[5])) return bad();
  if (p[1] !== installation) throw new ManagementClientError("wrong_installation", "This evidence belongs to another installation.");
  return { scopeId: p[2]!, requestId: p[3]!, itemId: p[4]!, digest: p[5]!, ref };
}
export function normalizeHandoverChange(v: unknown, installation: string): HandoverChange {
  if (!object(v) || typeof v.action !== "string" || !HANDOVER_ACTIONS.includes(v.action as HandoverAction)
    || !exact(v, ["requestId", "handoverRef", "action", "expectedRevision", "confirmed", ...(v.action === "attest" ? ["itemId", "evidenceRef"] : v.action === "retire" ? ["evidenceRef"] : [])])
    || typeof v.requestId !== "string" || !UUID.test(v.requestId) || typeof v.handoverRef !== "string" || !hash(v.expectedRevision) || v.confirmed !== true) return bad();
  const ref = protectionReferenceIdentity(v.handoverRef, installation, "handover");
  if (v.action === "attest") {
    if (typeof v.itemId !== "string" || !UUID.test(v.itemId) || typeof v.evidenceRef !== "string") return bad();
    const e = handoverEvidenceIdentity(v.evidenceRef, installation); if (e.scopeId !== ref.scopeId || e.itemId !== v.itemId) return bad();
  }
  if (v.action === "retire") {
    if (typeof v.evidenceRef !== "string" || handoverOperationIdentity(v.evidenceRef, installation).scopeId !== ref.scopeId) return bad();
  }
  return { ...v, requestId: v.requestId.toLowerCase(), handoverRef: ref.ref } as HandoverChange;
}
export function normalizeHandoverContinuation(v: unknown): HandoverContinuation {
  if (!object(v) || !exact(v, ["requestId", "scopeId", "action", "confirmed"]) || typeof v.requestId !== "string" || !UUID.test(v.requestId)
    || !hash(v.scopeId) || typeof v.action !== "string" || !["resume", "reconcile", "cancel"].includes(v.action) || v.confirmed !== true) return bad();
  return { requestId: v.requestId.toLowerCase(), scopeId: v.scopeId, action: v.action, confirmed: true } as HandoverContinuation;
}
export function handoverAssessment(v: unknown): v is HandoverAssessment {
  return object(v) && exact(v, ["evidenceHash", "observedAtMs", "healthySinceMs", "lastActivityAtMs", "newMessages", "coverage", "gap", "eligible", "automaticDeleteAuthorized", "blockers"])
    && hash(v.evidenceHash) && count(v.observedAtMs) && v.observedAtMs > 0 && [v.healthySinceMs, v.lastActivityAtMs].every(t => t === null || count(t) && t <= v.observedAtMs)
    && count(v.newMessages, 4096) && ["complete", "partial"].includes(v.coverage) && typeof v.gap === "boolean" && v.gap === (v.coverage === "partial")
    && typeof v.eligible === "boolean" && typeof v.automaticDeleteAuthorized === "boolean" && (!v.automaticDeleteAuthorized || v.eligible)
    && Array.isArray(v.blockers) && v.blockers.length <= 16 && v.blockers.every((s: unknown) => typeof s === "string" && /^[a-z_]{1,64}$/.test(s))
    && new Set(v.blockers).size === v.blockers.length && v.eligible === (v.blockers.length === 0);
}
export function handoverOperation(v: unknown, installation: string, scope: string, requestId: string): v is HandoverOperation {
  try {
    if (!object(v) || !exact(v, ["requestId", "operationRef", "handoverRef", "action", "expectedRevision", "state", "result", "createdAtMs", "privateInputsIncluded"])
      || v.requestId !== requestId || v.operationRef !== handoverOperationRef(installation, scope, requestId)
      || typeof v.handoverRef !== "string" || protectionReferenceIdentity(v.handoverRef, installation, "handover").scopeId !== scope
      || !HANDOVER_ACTIONS.includes(v.action) || !hash(v.expectedRevision) || !["admitted", "unknown", "completed", "cancelled"].includes(v.state)
      || !count(v.createdAtMs) || v.createdAtMs < 1 || v.privateInputsIncluded !== false) return false;
    if (v.state !== "completed") return v.result === null;
    const r = v.result;
    if (!object(r) || !exact(r, ["outcome", "reason", "revision", "remaining", "unknown", "complete", "assessment", "observations", "observationsTruncated", "sourceDeleted", "allDutiesComplete"])
      || !["advanced", "observed", "attested", "blocked", "retired"].includes(r.outcome) || !(r.reason === null || typeof r.reason === "string" && /^[a-z_]{1,64}$/.test(r.reason))
      || !hash(r.revision) || ![r.remaining, r.unknown, r.complete].every(n => count(n, 1024)) || r.unknown > r.remaining || r.remaining + r.complete > 1024
      || !(r.assessment === null || handoverAssessment(r.assessment)) || !Array.isArray(r.observations) || r.observations.length > 64
      || typeof r.observationsTruncated !== "boolean" || typeof r.sourceDeleted !== "boolean" || r.sourceDeleted !== (r.outcome === "retired")
      || r.allDutiesComplete !== false || v.action !== "observe" && (r.observations.length !== 0 || r.observationsTruncated)) return false;
    if (r.outcome !== "blocked" && r.outcome !== ({ advance: "advanced", observe: "observed", attest: "attested", retire: "retired" } as const)[v.action as HandoverAction]) return false;
    return new Set(r.observations.map((o: any) => o.itemId)).size === r.observations.length && r.observations.every((o: unknown) => {
      if (!object(o) || !exact(o, ["itemId", "inputDigest", "state", "evidenceHash", "evidenceRef"]) || !UUID.test(o.itemId) || !hash(o.inputDigest)
        || !["complete", "unknown", "unsupported", "not_dispatched"].includes(o.state)) return false;
      return o.state === "complete" ? hash(o.evidenceHash) && o.evidenceRef === handoverEvidenceRef(installation, scope, requestId, o.itemId, o.evidenceHash)
        : o.evidenceHash === null && o.evidenceRef === null;
    });
  } catch { return false; }
}
