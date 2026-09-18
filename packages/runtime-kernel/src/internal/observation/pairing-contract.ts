import { canonicalJson, sha256Text } from "../../hash.ts";
import { observationOwn as own } from "../contract/provider-observation.ts";
import { validateNotificationTarget, type NotificationTarget, type NotificationScope } from "./notification-contract.ts";
import { routineAgentId, routineId, routineRevision, type RoutineView, type RoutineSnapshot } from "../../routines.ts";

/** Pairing is a capability-changing action even when it only retrieves a native
 * credential. This first phase never enables a Routine or authorizes delivery. */
export const OPS_PAIRING_POLICY = Object.freeze({ maxSlots: 8, maxFileBytes: 64 * 1024, maxCredentialBytes: 8192, maxCredentialResponseBytes: 12 * 1024 });
export type PairingReason = "invalid_input" | "confirmation_required" | "target_unconfigured" | "unsupported_target" | "definition_changed"
  | "routine_not_disabled" | "unmanaged_routine" | "scope_changed" | "operation_conflict" | "pairing_busy" | "capacity"
  | "store_unavailable" | "credential_unavailable" | "credential_invalid" | "outcome_unknown" | "not_found";
export class OpsPairingError extends Error { constructor(readonly reason: PairingReason) { super(`ops_pairing_${reason}`); this.name = "OpsPairingError"; } }
export const pairingFail = (reason: PairingReason): never => { throw new OpsPairingError(reason); };
export function pairingAlias(v: unknown): string { return typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v) ? v : pairingFail("invalid_input"); }
export function pairingOperation(v: unknown): string { return typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v) ? v : pairingFail("invalid_input"); }
export function pairingScope(v: NotificationScope): NotificationScope {
  try { return { databaseId: routineAgentId(v.databaseId), scopeId: routineRevision(v.scopeId) }; } catch { return pairingFail("scope_changed"); }
}
/** Read a configured preference even with notifications off. This does not
 * override that off switch: the result can only prepare a disabled binding. */
export function pairingTarget(ops: unknown, name: string): NotificationTarget {
  pairingAlias(name); const t = own(own(ops, "targets"), name), notifications = own(ops, "notifications");
  if (!t || !own(t, "agentId") || !own(t, "routineKey")) return pairingFail("target_unconfigured");
  const intents = own(t, "allowedIntents");
  if (own(t, "dataPolicy") !== "safe-summary" || !Array.isArray(intents) || !intents.includes("brief-notice")
    || own(t, "modelChangePolicy") !== "require-rebind") return pairingFail("unsupported_target");
  try { return validateNotificationTarget({ alias: name, agentId: own(t, "agentId") as string, routineKey: own(t, "routineKey") as string,
    policyRevision: sha256Text(canonicalJson(ops)), dataPolicy: "safe-summary",
    installationLimit: own(notifications, "maxAutomaticWakeupsPerDay") as number,
    targetLimit: (own(t, "maxAutomaticWakeupsPerDay") ?? own(notifications, "maxAutomaticWakeupsPerDay")) as number }); }
  catch { return pairingFail("unsupported_target"); }
}
export type PairingCommand = { action: "preview" | "bind"; alias: string; routineId: string; expectedRevision: string; operationId: string; confirmed?: boolean };
export function validatePairingCommand(v: PairingCommand): PairingCommand {
  if (!v || !["preview", "bind"].includes(v.action) || Object.keys(v).some(k => !["action", "alias", "routineId", "expectedRevision", "operationId", "confirmed"].includes(k))) return pairingFail("invalid_input");
  if (v.action === "bind" && v.confirmed !== true) return pairingFail("confirmation_required");
  try { return { action: v.action, alias: pairingAlias(v.alias), routineId: routineId(v.routineId),
    expectedRevision: routineRevision(v.expectedRevision), operationId: pairingOperation(v.operationId), ...(v.confirmed ? { confirmed: true } : {}) }; }
  catch (e) { if (e instanceof OpsPairingError) throw e; return pairingFail("invalid_input"); }
}
export function observePairingRoutine(command: PairingCommand, snapshot: RoutineSnapshot): RoutineView {
  const item = snapshot.catalog.routines.find(r => r.id === command.routineId);
  if (!item || item.revision !== command.expectedRevision) return pairingFail("definition_changed");
  if (item.enabled) return pairingFail("routine_not_disabled");
  if (!item.mutable || item.trigger.type !== "webhook") return pairingFail("unsupported_target");
  return item;
}
export type PairingPlan = { schemaVersion: 1; fingerprint: string; operationId: string; target: NotificationTarget; scope: NotificationScope;
  routineId: string; routineRevision: string; generation: string };
export function pairingPlan(command: PairingCommand, target: NotificationTarget, scope: NotificationScope, snapshot: RoutineSnapshot): PairingPlan {
  validateNotificationTarget(target); pairingScope(scope); observePairingRoutine(command, snapshot);
  if (snapshot.catalog.agentId !== target.agentId) return pairingFail("scope_changed");
  try { routineRevision(snapshot.generation); } catch { return pairingFail("scope_changed"); }
  const body = { operationId: command.operationId, target, scope, routineId: command.routineId, routineRevision: command.expectedRevision, generation: snapshot.generation };
  return { schemaVersion: 1, ...body, fingerprint: sha256Text(canonicalJson(body)) };
}
export type PairingCredential = { url: string; key: string };
export function nativeAutomationIdentity(agentId: string, localId: string): string {
  routineAgentId(agentId); routineId(localId);
  const hex = sha256Text(`${agentId}\0${localId}`), variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Secret-bearing output stays behind the private owner. This verifies endpoint
 * identity, not origin allowlisting, HTTP authentication or send qualification. */
export function validatePairingCredential(value: unknown, plan: PairingPlan): PairingCredential {
  const url = own(value, "url"), key = own(value, "key");
  if (typeof url !== "string" || url.length > 2048 || typeof key !== "string" || key.length < 1
    || new TextEncoder().encode(key).length > OPS_PAIRING_POLICY.maxCredentialBytes || /[\x00-\x20\x7f]/.test(key)) return pairingFail("credential_invalid");
  let u: URL; try { u = new URL(url); } catch { return pairingFail("credential_invalid"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || u.search
    || u.pathname !== `/automations/webhook/${nativeAutomationIdentity(plan.target.agentId, plan.routineId)}`) return pairingFail("credential_invalid");
  return { url: u.toString(), key };
}
export type PairingRecord = { plan: PairingPlan; bindingId: string; revision: number; state: "enrolling" | "prepared" | "disabled" | "unbound";
  updatedAtMs: number; credentialPresent: boolean };
export function pairingReceipt(record: PairingRecord) {
  return { schemaVersion: 1, bindingId: record.bindingId, revision: record.revision, alias: record.plan.target.alias,
    agentId: record.plan.target.agentId, routineKey: record.plan.target.routineKey, routineId: record.plan.routineId,
    routineRevision: record.plan.routineRevision, operationId: record.plan.operationId,
    state: record.state === "enrolling" ? "outcome_unknown" as const : record.state,
    credential: record.credentialPresent ? "stored_private" as const : "not_available" as const,
    qualification: "not_verified", deliveryAuthorized: false, automaticEnable: false, webhookInvoked: false,
    modelChanged: false, remoteCredentialRevoked: false, automaticRetry: false, updatedAtMs: record.updatedAtMs };
}
