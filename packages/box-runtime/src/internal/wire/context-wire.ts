import { ContextFailure, WIRE_VERSION, exactKeys, parseContextCandidate, type ContextCandidate, type ContextMaintenanceRequest } from "@grokbox/runtime-kernel/contract";

export const CONTEXT_PAGE_CHARS = 128 * 1024;
export const CONTEXT_CONTROL_LIMIT = 2048;
export const CONTEXT_ACTIONS = ["authorize", "inspect", "preview", "commit", "readCommit", "page", "activity-start"] as const;
export type ContextAction = typeof CONTEXT_ACTIONS[number];
export type ContextCall = { version: typeof WIRE_VERSION; method: "context-call"; operationId: string; sequence: number;
  action: ContextAction; candidate?: ContextCandidate; offset?: number };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown, empty = false): v is string => typeof v === "string" && (empty || v.length > 0) && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const bad = (): never => { throw new ContextFailure("context_material_invalid"); };

/** Narrow operation identity, no model/credentials/policy supplied by the caller. */
export function parseContextStart(value: unknown): ContextMaintenanceRequest {
  if (!object(value) || value.version !== WIRE_VERSION || value.method !== "maintain-context"
    || !exactKeys(value, ["version", "method", "request"]) || !object(value.request)) return bad();
  const r = value.request;
  if (!exactKeys(r, ["operationId", "hostEpoch", "serviceEpoch", "agentId", "sessionId", "rootId", "rootRevision", "selection", "reason", "deadlineMs"], ["parent", "confirmed", "recoveryNonce"])) return bad();
  for (const k of ["operationId", "agentId", "rootId", "rootRevision"]) if (!id(r[k])) return bad();
  if (!id(r.sessionId, true) || !Number.isSafeInteger(r.deadlineMs) || Number(r.deadlineMs) <= 0 || Number(r.deadlineMs) > 180000
    || !["preflight", "manual", "overflow"].includes(String(r.reason)) || r.confirmed !== undefined && typeof r.confirmed !== "boolean") return bad();
  if (!object(r.hostEpoch) || !exactKeys(r.hostEpoch, ["compile", "source", "profile", "hostIdentity", "bridgeDigest", "wireVersion"])
    || Object.values(r.hostEpoch).some(v => !id(v)) || r.hostEpoch.wireVersion !== `v${WIRE_VERSION}`) return bad();
  if (!object(r.serviceEpoch) || !exactKeys(r.serviceEpoch, ["incarnationId"]) || !id(r.serviceEpoch.incarnationId)) return bad();
  if (!object(r.selection) || !exactKeys(r.selection, ["agentId", "modelId", "selectionRevision"])
    || Object.values(r.selection).some(v => !id(v)) || r.selection.agentId !== r.agentId || !/^[a-f0-9]{64}$/.test(String(r.selection.selectionRevision))) return bad();
  if (r.parent !== undefined && (!object(r.parent) || !exactKeys(r.parent, ["turnId"], ["stepId", "bindingId"])
    || Object.values(r.parent).some(v => !id(v)))) return bad();
  if (r.reason === "preflight" && (!object(r.parent) || !id(r.parent.stepId))) return bad();
  if (r.reason === "manual" && r.confirmed !== true) return bad();
  if (r.reason === "overflow" && (!object(r.parent) || !id(r.parent.stepId) || !id(r.parent.bindingId) || !id(r.recoveryNonce))) return bad();
  return r as unknown as ContextMaintenanceRequest;
}

export function parseContextCall(value: unknown, operationId: string, sequence: number): ContextCall {
  if (!object(value) || value.version !== WIRE_VERSION || value.method !== "context-call" || value.operationId !== operationId
    || value.sequence !== sequence || sequence >= CONTEXT_CONTROL_LIMIT
    || !exactKeys(value, ["version", "method", "operationId", "sequence", "action"], ["candidate", "offset"])
    || !(CONTEXT_ACTIONS as readonly unknown[]).includes(value.action)) return bad();
  if (value.action === "page") {
    if (!Number.isSafeInteger(value.offset) || Number(value.offset) <= 0 || value.candidate !== undefined) return bad();
  } else if (value.offset !== undefined) return bad();
  if (value.action === "preview" || value.action === "commit") {
    if (!object(value.candidate) || value.candidate.operationId !== operationId) return bad();
    const candidate = parseContextCandidate(value.candidate);
    return { ...value, candidate } as ContextCall;
  } else if (value.candidate !== undefined) return bad();
  return value as unknown as ContextCall;
}
