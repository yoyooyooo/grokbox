import { canonicalJson, sha256Text } from "../../hash.ts";
import { ContinuityFailure, continuityObject, continuityUint, failContinuity, isContinuityHash, isContinuityUuid } from "./material.ts";

/** Native duplication deliberately does not restore current context. The fixed
 * policy version binds disclosure/confirmation, not permission to execute tools. */
export const DUPLICATION_POLICY_REVISION = sha256Text("grokbox.native-duplicate.policy.v1");
export type DuplicateSource = {
  agentId: string; scopeId: string; generation: string; profileRevision: string; routineRevision: string;
  harness: "box" | "temporal"; observedAtMs: number;
  returnedRoutines: number; enabledRoutines: number; routineCoverage: "native_returned_window";
};
export function duplicateSource(raw: unknown): DuplicateSource {
  const v = continuityObject(raw, ["agentId", "scopeId", "generation", "profileRevision", "routineRevision", "harness", "observedAtMs", "returnedRoutines", "enabledRoutines", "routineCoverage"]);
  if (!isContinuityUuid(v.agentId) || ![v.scopeId, v.generation, v.profileRevision, v.routineRevision].every(isContinuityHash)
    || typeof v.harness !== "string" || !["box", "temporal"].includes(v.harness)
    || !continuityUint(v.observedAtMs) || v.observedAtMs < 1 || !continuityUint(v.returnedRoutines) || v.returnedRoutines > 100
    || !continuityUint(v.enabledRoutines) || v.enabledRoutines > v.returnedRoutines || v.routineCoverage !== "native_returned_window") return failContinuity("invalid_material");
  return { agentId: v.agentId, scopeId: v.scopeId as string, generation: v.generation as string, profileRevision: v.profileRevision as string,
    routineRevision: v.routineRevision as string, harness: v.harness as DuplicateSource["harness"], observedAtMs: v.observedAtMs,
    returnedRoutines: v.returnedRoutines, enabledRoutines: v.enabledRoutines, routineCoverage: "native_returned_window" };
}
export function duplicatePlan(source: DuplicateSource) {
  const checked = duplicateSource(source), { observedAtMs, ...facts } = checked;
  return { version: 1 as const, source: checked, revision: sha256Text(canonicalJson({ policy: DUPLICATION_POLICY_REVISION, ...facts })),
    semantics: "official_duplicate" as const,
    effects: { newIdentity: true, clearsConversation: true, copiesSelectedProfileAndSettings: true, copiesLocalRoutineDefinitions: true,
      routinesAutomaticallyPaused: false, maySelectNewActiveChat: true, targetInitiallyHidden: false,
      copiesCompleteMemoryAndBlobClosure: false, copiesGrokboxModelAssignment: false, transfersRelationships: false, deletesSource: false,
      guaranteedBox: false, nativeIdempotency: false, atomicSourceFreeze: false, mayPermitFutureRoutineRuns: true },
    routineCoverageComplete: false as const, fullClone: false as const };
}
export type DuplicateRequest = { version: 1; operationId: string; source: DuplicateSource; planRevision: string };
export function duplicateRequest(raw: unknown): DuplicateRequest {
  const v = continuityObject(raw, ["version", "operationId", "source", "planRevision"]);
  const source = duplicateSource(v.source);
  if (v.version !== 1 || !isContinuityUuid(v.operationId) || v.planRevision !== duplicatePlan(source).revision) return failContinuity("invalid_material");
  return { version: 1, operationId: v.operationId, source, planRevision: v.planRevision as string };
}
export const duplicateInputDigest = (request: DuplicateRequest) => sha256Text(canonicalJson(duplicateRequest(request)));
export function duplicateEffectId(operationId: string): string {
  if (!isContinuityUuid(operationId)) return failContinuity("invalid_material");
  const h = sha256Text(`native-duplicate:${operationId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export type DuplicateCreated = { version: 1; operationId: string; sourceAgentId: string; targetAgentId: string;
  scopeId: string; generation: string; receivedAtMs: number; evidence: "native_response" };
export function duplicateCreated(raw: unknown, request: DuplicateRequest): DuplicateCreated {
  const r = duplicateRequest(request), v = continuityObject(raw, ["version", "operationId", "sourceAgentId", "targetAgentId", "scopeId", "generation", "receivedAtMs", "evidence"]);
  if (v.version !== 1 || v.operationId !== r.operationId || v.sourceAgentId !== r.source.agentId || v.scopeId !== r.source.scopeId
    || v.generation !== r.source.generation || !isContinuityUuid(v.targetAgentId) || v.targetAgentId === r.source.agentId
    || !continuityUint(v.receivedAtMs) || v.receivedAtMs < r.source.observedAtMs || v.evidence !== "native_response") return failContinuity("invalid_material");
  return { version: 1, operationId: r.operationId, sourceAgentId: r.source.agentId, targetAgentId: v.targetAgentId,
    scopeId: r.source.scopeId, generation: r.source.generation, receivedAtMs: v.receivedAtMs, evidence: "native_response" };
}
export class DuplicateReceiptUnstored extends ContinuityFailure {
  readonly created: DuplicateCreated;
  constructor(created: DuplicateCreated, request: DuplicateRequest) {
    super("commit_unknown"); this.created = duplicateCreated(created, request);
  }
}
export type DuplicateTarget = { agentId: string; state: "confirmed_box" | "confirmed_temporal" | "conflict" | "unconfirmed"; readBack: boolean };
/** Only a local pre-dispatch check may construct this. An HTTP failure or
 * timeout must never be converted into a non-execution certificate. */
export class DuplicateDispatchRefused extends ContinuityFailure {
  constructor(readonly reason: "generation_changed" | "evidence_expired" | "cancelled") { super("conflict"); }
}
export type NativeDuplicatePort = {
  inspectSource: (agentId: string) => Promise<DuplicateSource>;
  duplicate: (request: DuplicateRequest, current: DuplicateSource) => Promise<DuplicateCreated>;
  inspectTarget: (created: DuplicateCreated) => Promise<DuplicateTarget>;
};
