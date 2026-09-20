import { botIdFromRef, type ContextView, type ContextOperation, type ContextChange } from "./contract.ts";
import { contextOperationIdentity, contextOperationRef } from "./context-contract.ts";
import { protectionReferenceIdentity } from "./protection-contract.ts";
import { record, exact, revision } from "./response-validation.ts";
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const token = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const bot = (v: unknown, installation: string): v is string => { try { return typeof v === "string" && v === `bot:${installation}:${botIdFromRef(v, installation)}`; } catch { return false; } };
const snapshot = (v: unknown, installation: string, scope: string) => {
  if (v === null) return true;
  try { const value = protectionReferenceIdentity(String(v), installation, "snapshot"); return value.ref === v && value.scopeId === scope; } catch { return false; }
};
export function contextView(v: unknown, installation: string, target: string): v is ContextView {
  return record(v) && exact(v, ["botRef", "scopeId", "revision", "policyRevision", "hostSourceSha", "nativeSchema", "hostGeneration", "state", "effects", "hasCheckpoint", "observedAtMs", "contentIncluded", "currentOwnershipProven"])
    && bot(v.botRef, installation) && v.botRef === target && revision(v.scopeId) && revision(v.revision) && revision(v.policyRevision) && revision(v.hostSourceSha)
    && token(v.nativeSchema) && token(v.hostGeneration) && ["empty", "prepared", "active", "interrupted"].includes(String(v.state))
    && ["clear", "unresolved"].includes(String(v.effects)) && typeof v.hasCheckpoint === "boolean" && (v.state !== "empty" || !v.hasCheckpoint)
    && integer(v.observedAtMs) && v.contentIncluded === false && v.currentOwnershipProven === false;
}
export function contextOperation(v: unknown, installation: string, ref: string, target?: string, change?: ContextChange): v is ContextOperation {
  try {
    const identity = contextOperationIdentity(ref, installation);
    if (!record(v) || !exact(v, ["requestId", "operationRef", "botRef", "scopeId", "action", "expectedRevision", "state", "captureRef", "backupRef", "candidateRef", "application", "activation", "activationExpectedRevision", "createdAtMs", "sourceBodyIncluded", "startedTask", "currentTargetUsability"])) return false;
    if (v.operationRef !== ref || v.operationRef !== contextOperationRef(installation, identity.scopeId, identity.requestId) || v.requestId !== identity.requestId || v.scopeId !== identity.scopeId
      || !bot(v.botRef, installation) || target !== undefined && v.botRef !== target || !revision(v.expectedRevision)
      || !["capture", "initialize", "reset", "restore"].includes(String(v.action)) || !["admitted", "unknown", "captured", "prepared", "released", "cancelled"].includes(String(v.state))
      || !["not-recorded", "prepared", "effect-unknown", "succeeded", "not-executed"].includes(String(v.application))
      || !["not-requested", "prepared", "unknown", "released"].includes(String(v.activation)) || !integer(v.createdAtMs) || (v.activation === "not-requested" ? v.activationExpectedRevision !== null : !revision(v.activationExpectedRevision))
      || ![v.captureRef, v.backupRef, v.candidateRef].every(r => snapshot(r, installation, identity.scopeId))
      || v.sourceBodyIncluded !== false || v.startedTask !== false || v.currentTargetUsability !== "not-observed") return false;
    if (change && (v.action !== change.action || v.expectedRevision !== change.expectedRevision || change.action === "initialize" && v.candidateRef !== null && v.candidateRef !== change.snapshotRef)) return false;
    if (v.action === "capture" ? v.application !== "not-recorded" || v.activation !== "not-requested" || v.backupRef !== null || v.candidateRef !== null
      : v.captureRef !== null || v.action === "initialize" && v.backupRef !== null) return false;
    if (v.state === "cancelled" && (v.application !== "not-recorded" || v.activation !== "not-requested")) return false;
    if (v.state === "captured" && (v.action !== "capture" || v.captureRef === null)) return false;
    if (v.state === "prepared" && (v.action === "capture" || v.application !== "succeeded" || v.activation === "unknown" || v.activation === "released")) return false;
    if (v.state === "released" && (v.application !== "succeeded" || v.activation !== "released") || v.activation === "released" && v.state !== "released") return false;
    return true;
  } catch { return false; }
}
