import { UUID, botIdFromRef } from "./contract.ts";
import { exact, record, revision } from "./response-validation.ts";
import { lifecycleReference, lifecycleIdentity, LIFECYCLE_PHASES, LIFECYCLE_STEPS,
  type LifecycleIntent, type LifecyclePreview, type LifecycleOperation, type LifecycleList } from "./lifecycle-contract.ts";
import { protectionReferenceIdentity } from "./protection-contract.ts";
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const bot = (v: unknown, installationId: string) => { try { return v === null || typeof v === "string" && v === `bot:${installationId}:${botIdFromRef(v, installationId)}`; } catch { return false; } };
const operationRef = (v: unknown, installationId: string, scopeId: unknown, requestId: unknown) => {
  try { return typeof scopeId === "string" && typeof requestId === "string" && v === lifecycleReference(installationId, scopeId, requestId); } catch { return false; }
};
export function lifecyclePreview(v: unknown, installationId: string, input: LifecycleIntent): v is LifecyclePreview {
  return record(v) && exact(v, ["requestId", "operationRef", "scopeId", "planRevision", "kind", "sourceBotRef", "targetName", "modelId", "instructionsSha256", "activate", "start", "maxRunMs", "materialPolicy", "planPersisted", "nativeEffectsPerformed", "sourceDeleted"])
    && v.requestId === input.requestId && revision(v.scopeId) && operationRef(v.operationRef, installationId, v.scopeId, v.requestId) && revision(v.planRevision)
    && v.kind === input.kind && v.sourceBotRef === input.sourceBotRef && bot(v.sourceBotRef, installationId)
    && typeof v.targetName === "string" && v.targetName.trim().length > 0 && new TextEncoder().encode(v.targetName).length <= 256 && (input.name === undefined || v.targetName === input.name)
    && (v.modelId === null || typeof v.modelId === "string" && v.modelId.length <= 512 && !/[\x00-\x20]/.test(v.modelId)) && (input.modelId === undefined || v.modelId === input.modelId)
    && revision(v.instructionsSha256) && v.activate === input.activate && v.start === input.start && v.maxRunMs === input.maxRunMs
    && v.materialPolicy === "best-effort-with-gaps" && v.planPersisted === false && v.nativeEffectsPerformed === false && v.sourceDeleted === false;
}
export function lifecycleOperation(v: unknown, installationId: string, expectedRef?: string, planRevision?: string, intent?: LifecycleIntent): v is LifecycleOperation {
  if (!record(v) || !exact(v, ["requestId", "operationRef", "scopeId", "planRevision", "kind", "sourceBotRef", "targetBotRef", "state", "steps", "effectsUnknown", "createdAtMs", "updatedAtMs", "requestedActivation", "requestedStartup", "handoverRef", "currentTargetUsability", "sourceRetirement", "privateInputsIncluded"])) return false;
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId) || !revision(v.scopeId) || !operationRef(v.operationRef, installationId, v.scopeId, v.requestId)
    || expectedRef !== undefined && v.operationRef !== expectedRef || !revision(v.planRevision) || planRevision !== undefined && v.planRevision !== planRevision
    || !["clone", "replace", "spawn"].includes(String(v.kind)) || !bot(v.sourceBotRef, installationId) || !bot(v.targetBotRef, installationId)
    || v.kind === "spawn" && v.sourceBotRef !== null || v.kind !== "spawn" && v.sourceBotRef === null || v.targetBotRef !== null && v.targetBotRef === v.sourceBotRef
    || !LIFECYCLE_PHASES.includes(v.state as never) || !Array.isArray(v.steps) || v.steps.length > LIFECYCLE_STEPS.length
    || !v.steps.every(s => record(s) && exact(s, ["step", "state"]) && LIFECYCLE_STEPS.includes(s.step as never) && ["effect_unknown", "complete"].includes(String(s.state)))
    || new Set(v.steps.map(s => s.step)).size !== v.steps.length || typeof v.effectsUnknown !== "boolean" || v.effectsUnknown !== v.steps.some(s => s.state === "effect_unknown")
    || !integer(v.createdAtMs, 1) || !integer(v.updatedAtMs, Number(v.createdAtMs)) || typeof v.requestedActivation !== "boolean" || typeof v.requestedStartup !== "boolean"
    || v.requestedStartup && !v.requestedActivation || v.currentTargetUsability !== "not-observed" || v.sourceRetirement !== "not-observed" || v.privateInputsIncluded !== false) return false;
  const completed = (step: string) => (v.steps as { step: string; state: string }[]).some(s => s.step === step && s.state === "complete");
  if (v.targetBotRef !== null && !completed("create") || completed("create") && v.targetBotRef === null
    || ["ready", "active", "active_with_handover"].includes(String(v.state)) && !completed("initialize")
    || ["active", "active_with_handover"].includes(String(v.state)) && (!v.requestedActivation || !completed("activate"))
    || v.state === "active_with_handover" && (v.kind !== "replace" || !completed("handover"))
    || v.kind === "spawn" && (!v.requestedActivation || !v.requestedStartup)) return false;
  if (intent && (v.kind !== intent.kind || v.sourceBotRef !== intent.sourceBotRef || v.requestedActivation !== intent.activate || v.requestedStartup !== intent.start)) return false;
  if (v.handoverRef !== null) {
    try { if (typeof v.handoverRef !== "string" || v.kind !== "replace" || protectionReferenceIdentity(v.handoverRef, installationId, "handover").scopeId !== v.scopeId) return false; } catch { return false; }
  }
  return true;
}
export function lifecycleList(v: unknown, installationId: string, limit: number): v is LifecycleList {
  if (!record(v) || !exact(v, ["operations", "scopeId", "nextCursor", "coverage"]) || !Array.isArray(v.operations) || v.operations.length > limit
    || v.scopeId !== null && !revision(v.scopeId) || v.coverage !== "retained-principal-workflows"
    || !v.operations.every(item => lifecycleOperation(item, installationId) && lifecycleIdentity(item.operationRef, installationId).scopeId === v.scopeId)
    || new Set(v.operations.map(item => item.operationRef)).size !== v.operations.length) return false;
  if (v.nextCursor === null) return true;
  if (typeof v.nextCursor !== "string" || v.operations.length === 0) return false;
  const parts = v.nextCursor.split(".");
  return parts.length === 3 && parts[0] === v.scopeId && UUID.test(parts[1]!) && revision(parts[2]);
}
