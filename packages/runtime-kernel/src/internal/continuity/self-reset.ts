import { canonicalJson, sha256Text } from "../../hash.ts";
import { continuityObject, continuityId, continuityUint, isContinuityHash, isContinuityToken, isContinuityUuid, failContinuity,
  type ContinuityFailureCode } from "./material.ts";
import { protectedStorageRef, type ProtectedStorageRef } from "../observation/continuity-contract.ts";

export const SELF_RESET_VERSION = 1 as const;
export const SELF_RESET_MAX_MATERIALS = 64;
export const SELF_RESET_MAX_WORKFLOWS = 32;
export const SELF_RESET_MAX_DUTIES = 64;
export const SELF_RESET_DUTY_KINDS = ["checkpoint", "memory", "tool", "workflow"] as const;
export type SelfResetDutyKind = typeof SELF_RESET_DUTY_KINDS[number];
export const SELF_RESET_QUEUE_STATES = ["queued", "effect_unknown", "complete", "blocked", "unknown"] as const;
export type SelfResetQueueState = typeof SELF_RESET_QUEUE_STATES[number];

const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\\x00-\\x1f]/.test(value)) return failContinuity("invalid_material");
  return value;
};
const boundedList = <A>(value: unknown, max: number, parse: (item: unknown) => A) => {
  if (!Array.isArray(value) || value.length > max) return failContinuity("invalid_material");
  const result = value.map(parse);
  if (new Set(result.map(item => canonicalJson(item))).size !== result.length) return failContinuity("conflict");
  return result;
};

export type SelfResetWorkflowRef = { operationId: string; digest: string };
export function selfResetWorkflowRef(raw: unknown): SelfResetWorkflowRef {
  const v = continuityObject(raw, ["operationId", "digest"]);
  if (!isContinuityUuid(v.operationId) || !isContinuityHash(v.digest)) return failContinuity("invalid_material");
  return { operationId: v.operationId, digest: v.digest };
}

export type SelfResetMaterialRef = ProtectedStorageRef;
export function selfResetMaterialRef(raw: unknown): SelfResetMaterialRef {
  const value = protectedStorageRef(raw);
  if (value.owner !== "continuity.recovery") return failContinuity("conflict");
  return value;
}

export type SelfResetDuty = { id: string; kind: SelfResetDutyKind; materialRefs: SelfResetMaterialRef[] };
export function selfResetDuty(raw: unknown): SelfResetDuty {
  const v = continuityObject(raw, ["id", "kind", "materialRefs"]);
  const id = text(v.id, 128);
  if (!isContinuityToken(id) || !(SELF_RESET_DUTY_KINDS as readonly unknown[]).includes(v.kind)) return failContinuity("invalid_material");
  return { id, kind: v.kind as SelfResetDutyKind, materialRefs: boundedList(v.materialRefs, SELF_RESET_MAX_MATERIALS, selfResetMaterialRef) };
}

export type SelfResetRequest = {
  version: 1;
  operationId: string;
  agentId: string;
  scopeId: string;
  sourceRevision: string;
  sourceGeneration: string;
  policyRevision: string;
  reason: string;
  materialRefs: SelfResetMaterialRef[];
  workflowRefs: SelfResetWorkflowRef[];
  duties: SelfResetDuty[];
  requestedAtMs: number;
};
export function selfResetRequest(raw: unknown): SelfResetRequest {
  const v = continuityObject(raw, ["version", "operationId", "agentId", "scopeId", "sourceRevision", "sourceGeneration", "policyRevision",
    "reason", "materialRefs", "workflowRefs", "duties", "requestedAtMs"]);
  if (v.version !== SELF_RESET_VERSION || !isContinuityUuid(v.operationId) || !isContinuityUuid(v.agentId)
    || !isContinuityHash(v.scopeId) || !isContinuityHash(v.sourceRevision) || !isContinuityToken(v.sourceGeneration)
    || !isContinuityHash(v.policyRevision) || typeof v.reason !== "string" || v.reason.length < 1 || v.reason.length > 256
    || /[\\x00-\\x1f]/.test(v.reason) || !continuityUint(v.requestedAtMs) || v.requestedAtMs < 1) return failContinuity("invalid_material");
  const materialRefs = boundedList(v.materialRefs, SELF_RESET_MAX_MATERIALS, selfResetMaterialRef);
  const workflowRefs = boundedList(v.workflowRefs, SELF_RESET_MAX_WORKFLOWS, selfResetWorkflowRef);
  const duties = boundedList(v.duties, SELF_RESET_MAX_DUTIES, selfResetDuty);
  const allMaterials = [...materialRefs, ...duties.flatMap(duty => duty.materialRefs)];
  if (new Set(allMaterials.map(value => canonicalJson(value))).size !== allMaterials.length) return failContinuity("conflict");
  return { version: 1, operationId: v.operationId, agentId: v.agentId, scopeId: v.scopeId, sourceRevision: v.sourceRevision,
    sourceGeneration: v.sourceGeneration, policyRevision: v.policyRevision, reason: v.reason, materialRefs, workflowRefs, duties,
    requestedAtMs: v.requestedAtMs };
}
export const selfResetDigest = (raw: SelfResetRequest) => sha256Text(canonicalJson(selfResetRequest(raw)));
export const selfResetEffectId = (operationId: string) => continuityId(operationId, "self-reset");
export const selfResetMaterialRefs = (request: SelfResetRequest): SelfResetMaterialRef[] =>
  [...request.materialRefs, ...request.duties.flatMap(duty => duty.materialRefs)].filter((value, index, all) =>
    all.findIndex(candidate => canonicalJson(candidate) === canonicalJson(value)) === index);

export type SelfResetCurrent = { sourceRevision: string; sourceGeneration: string; turnSettled: true };
export function selfResetCurrent(raw: unknown): SelfResetCurrent {
  const v = continuityObject(raw, ["sourceRevision", "sourceGeneration", "turnSettled"]);
  if (!isContinuityHash(v.sourceRevision) || !isContinuityToken(v.sourceGeneration) || v.turnSettled !== true) return failContinuity("conflict");
  return { sourceRevision: v.sourceRevision, sourceGeneration: v.sourceGeneration, turnSettled: true };
}

export type SelfResetDutyResult = { id: string; state: "pending" | "complete" | "blocked" | "unknown"; materialRefs?: SelfResetMaterialRef[]; reason?: string };
export function selfResetDutyResult(raw: unknown): SelfResetDutyResult {
  const v = continuityObject(raw, ["id", "state", "materialRefs", "reason"]);
  if (typeof v.id !== "string" || !isContinuityToken(v.id) || !["pending", "complete", "blocked", "unknown"].includes(String(v.state))) return failContinuity("invalid_material");
  const materialRefs = v.materialRefs === undefined ? undefined : boundedList(v.materialRefs, SELF_RESET_MAX_MATERIALS, selfResetMaterialRef);
  if (materialRefs?.length && new Set(materialRefs.map(value => canonicalJson(value))).size !== materialRefs.length) return failContinuity("conflict");
  const reason = v.reason === undefined ? undefined : text(v.reason, 256);
  return { id: v.id, state: v.state as SelfResetDutyResult["state"], ...(materialRefs ? { materialRefs } : {}), ...(reason ? { reason } : {}) };
}

export type SelfResetExecution = { state: "complete" | "blocked" | "unknown"; duties: SelfResetDutyResult[]; reason?: string };
export function selfResetExecution(raw: unknown, request: SelfResetRequest): SelfResetExecution {
  const v = continuityObject(raw, ["state", "duties", "reason"]);
  if (!["complete", "blocked", "unknown"].includes(String(v.state))) return failContinuity("invalid_material");
  const duties = boundedList(v.duties, SELF_RESET_MAX_DUTIES, selfResetDutyResult);
  const expected = new Set(request.duties.map(duty => duty.id));
  if (duties.some(duty => !expected.has(duty.id)) || duties.length !== expected.size) return failContinuity("conflict");
  const reason = v.reason === undefined ? undefined : text(v.reason, 256);
  if (v.state === "complete" && duties.some(duty => duty.state !== "complete")) return failContinuity("conflict");
  return { state: v.state as SelfResetExecution["state"], duties, ...(reason ? { reason } : {}) };
}

export type SelfResetReceipt = {
  operationId: string;
  agentId: string;
  state: SelfResetQueueState;
  requestDigest: string;
  sourceRevision: string;
  sourceGeneration: string;
  materialRefs: SelfResetMaterialRef[];
  workflowRefs: SelfResetWorkflowRef[];
  duties: SelfResetDutyResult[];
  reason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};
export const selfResetFailure = (code: ContinuityFailureCode): never => failContinuity(code);
