import { ManagementClientError, UUID, botIdFromRef } from "./contract.ts";
import type { RoutineBlueprint, RoutineView } from "@grokbox/runtime-kernel/routines";
export type { RoutineBlueprint };

export type NotificationSettings = {
  alias: string; botRef: string; routineKey: string; mode: "off" | "actionable-user";
  installationBudget: number; targetBudget: number;
};
export type NotificationSettingsView = {
  revision: string; mode: "off" | "actionable-user"; installationBudget: number;
  selectedAlias: string; advancedRouting: boolean; opsEnabled: boolean;
  targets: Array<{ alias: string; botRef: string | null; routineKey: string | null; targetBudget: number; enabled: boolean }>;
  source: "configuration"; grantsPermission: false;
};
export type PublicRoutine = RoutineView & { routineRef: string; botRef: string };
export type RoutineList = {
  botRef: string; routines: PublicRoutine[]; generation: string;
  coverage: { kind: "native_returned_window"; limit: 100; atLimit: boolean; complete: false };
};
export type SetupKind = "settings" | "routine" | "pairing";
export type SetupRequest = { requestId: string; confirmed: true } & (
  | { action: "settings"; expectedRevision: string; settings: NotificationSettings }
  | { action: "apply"; botRef: string; expectedRevision: string | null; blueprint: RoutineBlueprint }
  | { action: "enable" | "disable" | "delete" | "reconcile"; routineRef: string; expectedRevision: string }
  | { action: "bind"; alias: string; routineRef: string; databaseId: string; expectedRevision: string; expectedBindingRevision: number }
);
/** A durable local operation and a bounded native readback are different facts.
 * No setup action creates an automatic-notification grant or invokes a webhook. */
export type SetupOperation = {
  version: 1; kind: SetupKind; action: SetupRequest["action"]; requestId: string; operationRef: string;
  targetRef: string; resultRef: string | null; state: "succeeded" | "unknown" | "retired";
  beforeRevision: string | number | null; revision: string | number | null;
  evidence: "configuration-committed" | "disabled-definition-observed" | "requested-state-observed" | "absent-in-returned-window" | "credential-stored" | "not-verified" | "retired";
  nativeCompareAndSwap: false; webhookInvoked: false; grantsPermission: false;
};
export const setupKind = (action: SetupRequest["action"]): SetupKind => action === "settings" ? "settings" : action === "bind" ? "pairing" : "routine";
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const bad = (): never => { throw new ManagementClientError("invalid_input", "Invalid notification setup input. Persist the request UUID and review the exact target and revision."); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, "value"))) return bad();
  return row;
}
export function routineReference(installationId: string, botId: string, id: string): string {
  if (!UUID.test(installationId) || !UUID.test(botId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) return bad();
  return `routine:${installationId.toLowerCase()}:${botId.toLowerCase()}:${id}`;
}
export function routineIdentity(ref: string, installationId: string): { botId: string; routineId: string } {
  if (typeof ref !== "string") return bad();
  const parts = ref.split(":");
  if (parts.length !== 4 || parts[0] !== "routine" || !UUID.test(parts[1]!) || !UUID.test(parts[2]!) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(parts[3]!)) return bad();
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "The Routine belongs to another installation.");
  return { botId: parts[2]!.toLowerCase(), routineId: parts[3]! };
}
export function normalizeSetupRequest(value: unknown, installationId: string): SetupRequest {
  if (!UUID.test(installationId)) throw new ManagementClientError("wrong_installation", "Pin the installation before setup.");
  const all = object(value, ["action", "requestId", "confirmed", "expectedRevision", "settings", "botRef", "blueprint", "routineRef", "alias", "databaseId", "expectedBindingRevision"]);
  if (typeof all.requestId !== "string" || !UUID.test(all.requestId) || all.confirmed !== true) return bad();
  const base = { requestId: all.requestId.toLowerCase(), confirmed: true as const }, keys = ["action", "requestId", "confirmed", "expectedRevision"];
  const bot = (ref: unknown) => {
    if (typeof ref !== "string") return bad();
    return `bot:${installationId.toLowerCase()}:${botIdFromRef(ref, installationId)}`;
  };
  if (all.action === "settings") {
    object(all, [...keys, "settings"]);
    if (!hash(all.expectedRevision)) return bad();
    const s = object(all.settings, ["alias", "botRef", "routineKey", "mode", "installationBudget", "targetBudget"]);
    if (typeof s.alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(s.alias)
      || typeof s.routineKey !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(s.routineKey)
      || !["off", "actionable-user"].includes(String(s.mode))
      || ![s.installationBudget, s.targetBudget].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 1000)) return bad();
    return { ...base, action: "settings", expectedRevision: all.expectedRevision, settings: { alias: s.alias, botRef: bot(s.botRef), routineKey: s.routineKey,
      mode: s.mode as NotificationSettings["mode"], installationBudget: s.installationBudget as number, targetBudget: s.targetBudget as number } };
  }
  if (all.action === "apply") {
    object(all, [...keys, "botRef", "blueprint"]);
    if (all.expectedRevision !== null && !hash(all.expectedRevision)) return bad();
    const b = object(all.blueprint, ["schemaVersion", "key", "name", "prompt", "trigger", "isEnabled"]), t = object(b.trigger, ["type", "schedule"]);
    if (b.schemaVersion !== 1 || b.isEnabled !== false || typeof b.key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(b.key)
      || typeof b.name !== "string" || !b.name.trim() || b.name.trim() !== b.name || b.name.length > 64 || /[\x00-\x1f\x7f]/.test(b.name)
      || typeof b.prompt !== "string" || !b.prompt.trim() || b.prompt.trim() !== b.prompt || b.prompt.includes("\0") || new TextEncoder().encode(b.prompt).length > 16384
      || !(t.type === "webhook" && t.schedule === undefined || t.type === "cron" && typeof t.schedule === "string" && !!t.schedule.trim() && t.schedule.length <= 512 && !/[\x00-\x1f]/.test(t.schedule))) return bad();
    return { ...base, action: "apply", botRef: bot(all.botRef), expectedRevision: all.expectedRevision as string | null,
      blueprint: structuredClone(b) as unknown as RoutineBlueprint };
  }
  if (["enable", "disable", "delete", "bind", "reconcile"].includes(String(all.action))) {
    if (!hash(all.expectedRevision) || typeof all.routineRef !== "string") return bad();
    const target = routineIdentity(all.routineRef, installationId), routineRef = routineReference(installationId, target.botId, target.routineId);
    if (all.action === "bind") {
      object(all, [...keys, "routineRef", "alias", "databaseId", "expectedBindingRevision"]);
      if (typeof all.alias !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(all.alias) || typeof all.databaseId !== "string" || !UUID.test(all.databaseId)
        || !Number.isSafeInteger(all.expectedBindingRevision) || Number(all.expectedBindingRevision) < 0) return bad();
      return { ...base, action: "bind", alias: all.alias, databaseId: all.databaseId.toLowerCase(), routineRef,
        expectedRevision: all.expectedRevision, expectedBindingRevision: all.expectedBindingRevision as number };
    }
    object(all, [...keys, "routineRef"]);
    return { ...base, action: all.action as "enable" | "disable" | "delete" | "reconcile", routineRef, expectedRevision: all.expectedRevision };
  }
  return bad();
}
