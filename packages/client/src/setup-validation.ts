import { UUID, routineIdentity, routineReference, setupKind, normalizeSetupRequest, type SetupKind, type SetupRequest, type SetupOperation } from "./contract.ts";
import { exact, record, revision } from "./response-validation.ts";
const alias = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v);
const budget = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1000;
const time = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) >= 0;
const bot = (v: unknown, installation: string): v is string => typeof v === "string" && v.startsWith(`bot:${installation}:`) && v.split(":").length === 3 && UUID.test(v.split(":")[2]!);
const routine = (v: unknown, installation: string): v is string => {
  try { if (typeof v !== "string") return false; const p = routineIdentity(v,installation); return routineReference(installation,p.botId,p.routineId) === v; }
  catch { return false; }
};
export function settingsView(v: unknown, installation: string): boolean {
  return record(v) && exact(v,["revision","mode","installationBudget","selectedAlias","advancedRouting","opsEnabled","targets","source","grantsPermission"])
    && revision(v.revision) && ["off","actionable-user"].includes(String(v.mode)) && budget(v.installationBudget) && alias(v.selectedAlias)
    && typeof v.advancedRouting === "boolean" && typeof v.opsEnabled === "boolean" && v.source === "configuration" && v.grantsPermission === false
    && Array.isArray(v.targets) && v.targets.length <= 8 && v.targets.every(t => record(t) && exact(t,["alias","botRef","routineKey","targetBudget","enabled"])
      && alias(t.alias) && (t.botRef === null || bot(t.botRef,installation)) && (t.routineKey === null || typeof t.routineKey === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(t.routineKey))
      && budget(t.targetBudget) && typeof t.enabled === "boolean") && new Set(v.targets.map(t => t.alias)).size === v.targets.length;
}
export function blueprintView(v: unknown, installation: string): boolean {
  try { normalizeSetupRequest({ action:"apply",botRef:`bot:${installation}:11111111-1111-4111-8111-111111111111`,blueprint:v,expectedRevision:null,
    requestId:"11111111-1111-4111-8111-111111111111",confirmed:true },installation); return true; } catch { return false; }
}
export function routineList(v: unknown, installation: string, targetBot: string, selected?: string): boolean {
  if (!record(v) || !exact(v,["botRef","routines","generation","coverage"]) || v.botRef !== targetBot || !bot(v.botRef,installation) || !revision(v.generation)
    || !record(v.coverage) || !exact(v.coverage,["kind","limit","atLimit","complete"]) || v.coverage.kind !== "native_returned_window" || v.coverage.limit !== 100
    || v.coverage.complete !== false || typeof v.coverage.atLimit !== "boolean" || !Array.isArray(v.routines) || v.routines.length > 100) return false;
  if (selected && (v.routines.length !== 1 || v.routines[0]?.routineRef !== selected)) return false;
  return new Set(v.routines.map(r => r.id)).size === v.routines.length && v.routines.every(r => record(r)
    && exact(r,["id","name","enabled","trigger","revision","definitionRevision","mutable","createdAtMs","lastRunAtMs","nextRunAtMs","promptIncluded","credentialsIncluded","nativeCompareAndSwap","routineRef","botRef"])
    && routine(r.routineRef,installation) && r.botRef === targetBot && r.routineRef === `routine:${installation}:${targetBot.split(":")[2]}:${r.id}`
    && typeof r.name === "string" && r.name.length <= 512 && !r.name.includes("\0") && typeof r.enabled === "boolean" && typeof r.mutable === "boolean"
    && revision(r.revision) && revision(r.definitionRevision) && [r.createdAtMs,r.lastRunAtMs,r.nextRunAtMs].every(time)
    && r.promptIncluded === false && r.credentialsIncluded === false && r.nativeCompareAndSwap === false
    && record(r.trigger) && (r.trigger.type === "cron" ? exact(r.trigger,["type","schedule"]) && typeof r.trigger.schedule === "string" && r.trigger.schedule.length <= 512
      : exact(r.trigger,["type"]) && ["webhook","unsupported"].includes(String(r.trigger.type))));
}
export function setupOperation(v: unknown, installation: string, kind: SetupKind, scope: string, requestId: string, request?: SetupRequest): v is SetupOperation {
  if (!record(v) || !exact(v,["version","kind","action","requestId","operationRef","targetRef","resultRef","state","beforeRevision","revision","evidence","nativeCompareAndSwap","webhookInvoked","grantsPermission"])
    || v.version !== 1 || v.kind !== kind || v.requestId !== requestId || !UUID.test(requestId)
    || typeof v.operationRef !== "string" || v.operationRef.split(":").length !== 5 || !v.operationRef.startsWith(`setup-operation:${installation}:${kind}:${scope}:`) || !revision(v.operationRef.split(":").at(-1))
    || !["succeeded","unknown","retired"].includes(String(v.state)) || v.nativeCompareAndSwap !== false || v.webhookInvoked !== false || v.grantsPermission !== false) return false;
  if (kind === "settings") {
    if (v.action !== "settings" || v.targetRef !== `notification-settings:${installation}` || v.resultRef !== null || !revision(v.beforeRevision)
      || (v.state === "succeeded" ? !revision(v.revision) || v.evidence !== "configuration-committed" : v.state !== "unknown" || v.revision !== null || v.evidence !== "not-verified")) return false;
  } else if (kind === "pairing") {
    if (v.action !== "bind" || !routine(v.targetRef,installation) || typeof v.resultRef !== "string" || v.resultRef.split(":").length !== 4
      || !v.resultRef.startsWith(`receiver:${installation}:`) || !UUID.test(v.resultRef.split(":")[2]!) || !UUID.test(v.resultRef.split(":")[3]!)
      || !Number.isSafeInteger(v.beforeRevision) || Number(v.beforeRevision) < 0 || v.revision !== Number(v.beforeRevision)+1
      || (v.state === "succeeded" ? v.evidence !== "credential-stored" : v.state !== "unknown" || v.evidence !== "not-verified")) return false;
  } else {
    if (!["apply","enable","disable","delete"].includes(String(v.action)) || !UUID.test(scope)) return false;
    if (v.action === "apply") {
      if (v.targetRef !== `bot:${installation}:${scope}` || !(v.resultRef === null || routine(v.resultRef,installation) && v.resultRef.startsWith(`routine:${installation}:${scope}:`))) return false;
    } else if (!routine(v.targetRef,installation) || !v.targetRef.startsWith(`routine:${installation}:${scope}:`) || v.resultRef !== v.targetRef || !revision(v.beforeRevision)) return false;
    if (!(v.beforeRevision === null || revision(v.beforeRevision)) || !(v.revision === null || revision(v.revision))) return false;
    if (v.state === "succeeded") {
      const evidence = v.action === "apply" ? "disabled-definition-observed" : v.action === "delete" ? "absent-in-returned-window" : "requested-state-observed";
      if (v.evidence !== evidence || (v.action === "delete" ? v.revision !== null : !revision(v.revision)) || v.resultRef === null) return false;
    } else if (v.state === "retired" ? v.action !== "apply" || v.evidence !== "retired" : v.evidence !== "not-verified") return false;
  }
  if (request?.action === "reconcile") {
    return kind === "routine" && v.action === "apply" && v.targetRef === `bot:${installation}:${scope}`
      && (v.state === "succeeded" ? v.resultRef === request.routineRef : v.resultRef === null || v.resultRef === request.routineRef);
  }
  if (request) {
    if (v.action !== request.action || v.kind !== setupKind(request.action)) return false;
    const target = request.action === "settings" ? `notification-settings:${installation}` : request.action === "apply" ? request.botRef : request.routineRef;
    if (v.targetRef !== target) return false;
    if (v.state !== "retired" && v.beforeRevision !== (request.action === "bind" ? request.expectedBindingRevision : request.expectedRevision)) return false;
    if (request.action === "bind" && typeof v.resultRef === "string" && v.resultRef.split(":")[2] !== request.databaseId) return false;
  }
  return true;
}
