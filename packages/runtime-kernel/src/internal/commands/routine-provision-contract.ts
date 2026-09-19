import { canonicalJson, sha256Text } from "../../hash.ts";
import { routineAgentId, routineId, routineRevision, type RoutineCatalog, type RoutineView } from "../../routines.ts";

export const ROUTINE_PROVISION_POLICY = Object.freeze({ schemaVersion: 1, maxInputBytes: 24 * 1024, maxPromptBytes: 16 * 1024,
  maxOperations: 256, maxDatabaseBytes: 2 * 1024 * 1024 });
export type ProvisionReason = "invalid_input" | "confirmation_required" | "not_recorded" | "revision_conflict" | "operation_conflict" | "key_busy"
  | "capacity" | "ledger_unavailable" | "source_unavailable" | "unsupported" | "outcome_unknown";
export class RoutineProvisionError extends Error {
  constructor(readonly reason: ProvisionReason) { super(`routine_provision_${reason}`); this.name = "RoutineProvisionError"; }
}
const fail = (reason: ProvisionReason = "invalid_input"): never => { throw new RoutineProvisionError(reason); };
function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, "value")) return fail();
  return row;
}
export function provisionOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) return fail(); return value;
}
export type RoutineBlueprint = { schemaVersion: 1; key: string; name: string; prompt: string; trigger: { type: "webhook" } | { type: "cron"; schedule: string }; isEnabled: false };
export function parseRoutineBlueprint(value: unknown): RoutineBlueprint {
  const r = object(value, ["schemaVersion", "key", "name", "prompt", "trigger", "isEnabled"]), t = object(r.trigger, ["type", "schedule"]);
  if (r.schemaVersion !== 1 || !["webhook", "cron"].includes(String(t.type))
    || t.type === "webhook" && t.schedule !== undefined
    || t.type === "cron" && (typeof t.schedule !== "string" || !t.schedule.trim() || t.schedule.length > 512 || /[\x00-\x1f]/.test(t.schedule))
    || r.isEnabled !== undefined && r.isEnabled !== false
    || typeof r.key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(r.key)
    || typeof r.name !== "string" || r.name.trim() !== r.name || r.name.length < 1 || r.name.length > 64 || /[\x00-\x1f\x7f]/.test(r.name)
    || typeof r.prompt !== "string" || !r.prompt.trim() || r.prompt.trim() !== r.prompt || r.prompt.includes("\0")
    || new TextEncoder().encode(r.prompt).length > ROUTINE_PROVISION_POLICY.maxPromptBytes) return fail();
  return { schemaVersion: 1, key: r.key, name: r.name, prompt: r.prompt, trigger: t.type === "webhook" ? { type: "webhook" } : { type: "cron", schedule: t.schedule as string }, isEnabled: false };
}
export type RoutineProvisionCommand =
  | { action: "apply"; agentId: string; operationId: string; confirmed: true; blueprint: RoutineBlueprint; expectedRevision?: string }
  | { action: "outcome"; agentId: string; operationId: string }
  | { action: "reconcile"; agentId: string; operationId: string; confirmed: true; routineId: string };
export function validateProvisionCommand(value: unknown): RoutineProvisionCommand {
  const r = object(value, ["action", "agentId", "operationId", "confirmed", "blueprint", "expectedRevision", "routineId"]);
  let agentId: string;
  try { agentId = routineAgentId(r.agentId); } catch { return fail(); }
  const operationId = provisionOperationId(r.operationId);
  if (r.action === "outcome") {
    if (Object.keys(r).some(k => !["action", "agentId", "operationId"].includes(k))) return fail();
    return { action: "outcome", agentId, operationId };
  }
  if (r.confirmed !== true) return fail("confirmation_required");
  if (r.action === "apply" && r.routineId === undefined) {
    let expectedRevision: string | undefined;
    try { if (r.expectedRevision !== undefined) expectedRevision = routineRevision(r.expectedRevision); } catch { return fail(); }
    return { action: "apply", agentId, operationId, confirmed: true, blueprint: parseRoutineBlueprint(r.blueprint), ...(expectedRevision ? { expectedRevision } : {}) };
  }
  if (r.action === "reconcile" && r.blueprint === undefined && r.expectedRevision === undefined) {
    try { return { action: "reconcile", agentId, operationId, confirmed: true, routineId: routineId(r.routineId) }; } catch { return fail(); }
  }
  return fail();
}
export function nativeRoutineSpec(blueprint: RoutineBlueprint) {
  return { name: blueprint.name, prompt: blueprint.prompt, trigger: blueprint.trigger, isEnabled: false as const };
}
/** No prompt is written into the ledger. Reconciliation compares the exact
 * native definition digest for an explicitly supplied ID, never a name search. */
export function desiredRoutineDigest(blueprint: RoutineBlueprint): string { return sha256Text(canonicalJson(nativeRoutineSpec(blueprint))); }
export function observedRoutineDefinitionDigest(value: unknown): string {
  const r = object(value, ["name", "prompt", "trigger", "isEnabled"]);
  const b = parseRoutineBlueprint({ schemaVersion: 1, key: "probe", ...r });
  if (r.isEnabled !== false) return fail("unsupported"); return desiredRoutineDigest(b);
}
export function provisionFingerprint(command: Extract<RoutineProvisionCommand, { action: "apply" }>) {
  return sha256Text(canonicalJson([command.agentId, command.blueprint.key, desiredRoutineDigest(command.blueprint), command.expectedRevision ?? null]));
}
export type ProvisionBinding = { key: string; routineId: string; revision: string; operationId: string };
export type ProvisionRecord = {
  schemaVersion: 1; agentId: string; operationId: string; key: string; fingerprint: string; desiredDigest: string;
  action: "create" | "update"; state: "attempting" | "unknown" | "observed";
  nativeId: string | null; observedRevision: string | null; beforeRevision: string | null; createdAtMs: number;
};
export type ProvisionObservation = { catalog: RoutineCatalog; generation: string; definitions: ReadonlyMap<string, string> };
export type ProvisionReservation = { agentId: string; operationId: string; key: string; fingerprint: string; desiredDigest: string;
  action: "create" | "update"; binding: ProvisionBinding | null; atMs: number };
export function planProvision(command: Extract<RoutineProvisionCommand, { action: "apply" }>, binding: ProvisionBinding | null, before: ProvisionObservation) {
  if (before.catalog.agentId !== command.agentId || before.catalog.coverage.atLimit) return fail("unsupported");
  if (!binding) {
    if (command.expectedRevision !== undefined) return fail("revision_conflict");
    return { action: "create" as const, nativeId: null };
  }
  const item = before.catalog.routines.find(r => r.id === binding.routineId);
  if (!item || !item.mutable || item.trigger.type !== command.blueprint.trigger.type) return fail("unsupported");
  if (!command.expectedRevision || command.expectedRevision !== item.revision || binding.revision !== item.revision) return fail("revision_conflict");
  return { action: "update" as const, nativeId: binding.routineId };
}
export function verifyProvisionObservation(record: ProvisionRecord, observation: ProvisionObservation, nativeId: string): RoutineView {
  const item = observation.catalog.routines.find(r => r.id === nativeId);
  if (observation.catalog.agentId !== record.agentId || !item || !item.mutable || item.enabled || item.trigger.type === "unsupported"
    || observation.definitions.get(nativeId) !== record.desiredDigest) return fail("outcome_unknown");
  return item;
}
export function provisionReceipt(record: ProvisionRecord | null, agentId: string, operationId: string) {
  return { schemaVersion: 1, agentId, operationId, state: record?.state === "observed" ? "disabled_definition_observed" : record ? "outcome_unknown" : "not_recorded",
    ...(record ? { key: record.key, action: record.action, routineId: record.nativeId, revision: record.observedRevision, createdAtMs: record.createdAtMs } : {}),
    nativeCompareAndSwap: false, nativeIdempotency: false, automaticRetry: false, automaticEnable: false, webhookInvoked: false,
    inFlightRunsCancelled: false, durableReplayGuard: true, promptPersisted: false, currentNativeState: "not_checked" } as const;
}
export type RoutineProvisionReceipt = ReturnType<typeof provisionReceipt>;
export function projectProvisionReceipt(command: RoutineProvisionCommand, value: unknown): RoutineProvisionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("source_unavailable");
  const r = value as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(r, k)!, "value")) return fail("source_unavailable");
  if (r.schemaVersion !== 1 || r.agentId !== command.agentId || r.operationId !== command.operationId
    || !["not_recorded", "outcome_unknown", "disabled_definition_observed"].includes(String(r.state))
    || ["nativeCompareAndSwap", "nativeIdempotency", "automaticRetry", "automaticEnable", "webhookInvoked", "inFlightRunsCancelled", "promptPersisted"].some(k => r[k] !== false)
    || r.durableReplayGuard !== true || r.currentNativeState !== "not_checked") return fail("source_unavailable");
  if (r.state === "not_recorded") return provisionReceipt(null, command.agentId, command.operationId);
  if (typeof r.key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(r.key) || !["create", "update"].includes(String(r.action))
    || !Number.isSafeInteger(r.createdAtMs) || Number(r.createdAtMs) < 1) return fail("source_unavailable");
  let nativeId: string | null, revision: string | null;
  try { nativeId = r.routineId === null ? null : routineId(r.routineId); revision = r.revision === null ? null : routineRevision(r.revision); } catch { return fail("source_unavailable"); }
  if (r.state === "disabled_definition_observed" && (!nativeId || !revision)) return fail("source_unavailable");
  if (command.action === "apply" && r.key !== command.blueprint.key
    || command.action === "reconcile" && r.state === "disabled_definition_observed" && nativeId !== command.routineId) return fail("source_unavailable");
  return provisionReceipt({ schemaVersion: 1, agentId: command.agentId, operationId: command.operationId, key: r.key,
    fingerprint: "", desiredDigest: "", action: r.action as "create" | "update", state: r.state === "disabled_definition_observed" ? "observed" : "unknown",
    nativeId, observedRevision: revision, beforeRevision: null, createdAtMs: Number(r.createdAtMs) }, command.agentId, command.operationId);
}
