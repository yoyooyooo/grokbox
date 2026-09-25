import { canonicalJson, sha256Text } from "../../portable-hash.ts";
import { composeAgentTitle, parseAgentTitle } from "../contract/title-marker.ts";
import { ContinuityFailure, isContinuityHash, isContinuityUuid } from "./primitives.ts";

/** One native RPC per reviewed intent. Profile/settings and post-create changes
 * are deliberately separate operations, never an invisible write sequence. */
export const PRODUCT_ACTIONS = ["create", "update", "delete", "duplicate", "members", "hidden", "notify"] as const;
export type ProductAction = typeof PRODUCT_ACTIONS[number];
export type ProductKind = "bot" | "group";
export type ProductProfile = { name: string; description: string; title: string; avatarShape: string; avatarColor: string };
export type ObservedProductProfile = Omit<ProductProfile, "avatarShape" | "avatarColor"> & { avatarShape: string | null; avatarColor: string | null };
export type ProductIntent = {
  requestId: string; kind: ProductKind; action: ProductAction; targetId: string | null;
  profile: Partial<ProductProfile> | null; memberIds: string[] | null;
  harness: "box" | "temporal" | null; value: boolean | null; deferStart: boolean;
};
export type ProductObject = {
  id: string; kind: ProductKind; profile: ObservedProductProfile; memberIds: string[];
  harness: "box" | "temporal" | null; hidden: boolean | null; notify: boolean | null;
  revision: string;
};
export type ProductAuthority = {
  scopeId: string; generation: string; observedAtMs: number; identityRevision: string;
  permission: "native-authenticated-account"; atomicCompareAndSet: false;
};
export type ProductSnapshot = { objects: ProductObject[]; authority: ProductAuthority; coverage: "current-native-roster" };
export type ProductOwnership = {
  scopeId: string; sourceGeneration: string; observedAtMs: number;
  agents: Array<{ id: string; state: "confirmed_box" | "confirmed_temporal" | "conflict" | "unconfirmed";
    serverId: string | null; viewerIsOwner: boolean | null }>;
  coverage: "requested-native-registration"; executionQualified: false;
};
export type ProductRelations = {
  botId: string; scopeId: string; sourceGeneration: string; observedAtMs: number;
  groups: Array<{ id: string; memberIds: string[]; revision: string }>; groupsTruncated: boolean;
  transcript: { state: "observed" | "unavailable"; returnedEntries: number; peerIds: string[];
    inbound: Array<{ id: string; requestId: string | null; fromBotId: string; toBotId: string | null }>;
    coverage: "bounded-native-peer-fields"; complete: false };
  routines: { state: "observed" | "unavailable"; items: Array<{ id: string; revision: string; enabled: boolean; mutable: boolean }>;
    coverage: "native-returned-window"; complete: false };
  currentRosterCoverage: "native-snapshot"; externalTasksEnumerated: false;
};
export type ProductPlan = {
  intent: ProductIntent; scopeId: string; revision: string; sourceGeneration: string;
  target: ProductObject | null; profileAfter: Partial<ProductProfile> | null; memberRevision: string | null; duplicateRevision: string | null;
  atomicCompareAndSet: false; nativeIdempotency: "not-guaranteed";
  effects: string[]; nativeEffectsPerformed: false;
};
export type ProductSubmission = ProductIntent & { scopeId: string; expectedRevision: string; confirmed: true; acceptNonAtomic: true };
export type ProductDiagnostic = {
  phase: "native-call" | "http-response" | "response-body" | "response-shape" | "dispatch";
  code: "source_unavailable" | "source_unauthorized" | "source_timeout" | "source_invalid" | "source_changed" | "unexpected_failure";
  method: string | null; httpStatus: number | null; observedAtMs: number; detailStored: boolean;
};
export type ProductReceipt = {
  requestId: string; operationId: string; installationId: string; principalId: string; scopeId: string;
  intent: ProductIntent; planRevision: string; state: "prepared" | "effect_unknown" | "complete";
  result: ProductResult | null; diagnostic: ProductDiagnostic | null; createdAtMs: number;
};
export type ProductResult = {
  nativeReceipt: "returned" | "not-dispatched"; targetId: string | null;
  readBack: "matched" | "mismatch" | "not-observed"; object: ProductObject | null;
  cleanup: "not-applicable" | "native-lifecycle" | "complete" | "unavailable" | "unknown";
  atomicCompareAndSet: false; relationshipsTransferred: false; fullClone: false;
};
export class NativeProductError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "source_changed" | "source_unavailable" | "source_incomplete" | "permission_denied" | "revision_conflict") { super(code); }
}
const bad = (): never => { throw new NativeProductError("invalid_input"); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ownKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
export const PRODUCT_PROFILE_KEYS = ["name", "description", "title", "avatarShape", "avatarColor"] as const;
export function productProfile(raw: unknown, partial = false, normalize = false): Partial<ProductProfile> {
  if (!object(raw) || !ownKeys(raw, PRODUCT_PROFILE_KEYS) || !Object.keys(raw).length) return bad();
  const result: Partial<ProductProfile> = {};
  for (const key of PRODUCT_PROFILE_KEYS) {
    const value = raw[key];
    if (value === undefined) { if (!partial) result[key] = ""; continue; }
    const max = key === "description" ? 16384 : key === "title" ? 2048 : 256;
    if (typeof value !== "string" || new TextEncoder().encode(value).length > max || /[\x00]/.test(value) || key === "name" && !value.trim()) return bad();
    result[key] = normalize ? value.trim() : value;
  }
  if (!partial && !result.name?.trim()) return bad();
  return result;
}
export function productMembers(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6 || raw.some(id => !isContinuityUuid(id))) return bad();
  const ids = raw.map(id => (id as string).toLowerCase());
  if (new Set(ids).size !== ids.length) return bad();
  return ids.sort();
}
const INTENT_KEYS = ["requestId", "kind", "action", "targetId", "profile", "memberIds", "harness", "value", "deferStart"];
export function productIntent(raw: unknown): ProductIntent {
  if (!object(raw) || !ownKeys(raw, INTENT_KEYS) || !isContinuityUuid(raw.requestId)
    || !["bot", "group"].includes(String(raw.kind)) || !PRODUCT_ACTIONS.includes(raw.action as ProductAction)) return bad();
  const action = raw.action as ProductAction, kind = raw.kind as ProductKind;
  const targetId = raw.targetId == null ? null : isContinuityUuid(raw.targetId) ? raw.targetId.toLowerCase() : bad();
  if ((action === "create") !== (targetId === null)) return bad();
  const profile = raw.profile == null ? null : productProfile(raw.profile, action !== "create", true);
  if (["create", "update"].includes(action) !== (profile !== null)) return bad();
  const memberIds = raw.memberIds == null ? null : productMembers(raw.memberIds);
  if ((kind === "group" && ["create", "members"].includes(action)) !== (memberIds !== null) || action === "members" && kind !== "group") return bad();
  const harness = raw.harness == null ? null : ["box", "temporal"].includes(String(raw.harness)) ? raw.harness as "box" | "temporal" : bad();
  if ((kind === "bot" && action === "create") !== (harness !== null)) return bad();
  if (kind === "group" && action === "create" && Object.keys(raw.profile as object).some(k => !["name", "description"].includes(k))) return bad();
  if (action === "duplicate" && kind !== "bot") return bad();
  const value = raw.value == null ? null : typeof raw.value === "boolean" ? raw.value : bad();
  if (["hidden", "notify"].includes(action) !== (value !== null)) return bad();
  if (raw.deferStart !== undefined && typeof raw.deferStart !== "boolean") return bad();
  const deferStart = raw.deferStart === true;
  if (deferStart && (action !== "create" || kind !== "bot" || harness !== "box")) return bad();
  // Group creation only owns the native name/description/member RPC.
  const normalizedProfile = kind === "group" && action === "create" ? { name: profile!.name!, description: profile!.description ?? "" } : profile;
  return { requestId: raw.requestId.toLowerCase(), kind, action, targetId, profile: normalizedProfile, memberIds, harness, value, deferStart };
}
export function productSubmission(raw: unknown): ProductSubmission {
  if (!object(raw) || !ownKeys(raw, [...INTENT_KEYS, "scopeId", "expectedRevision", "confirmed", "acceptNonAtomic"])
    || !isContinuityHash(raw.scopeId) || !isContinuityHash(raw.expectedRevision) || raw.confirmed !== true || raw.acceptNonAtomic !== true) return bad();
  return { ...productIntent(Object.fromEntries(Object.entries(raw).filter(([k]) => INTENT_KEYS.includes(k)))),
    scopeId: raw.scopeId, expectedRevision: raw.expectedRevision, confirmed: true, acceptNonAtomic: true };
}
export function productObject(raw: unknown): ProductObject {
  if (!object(raw) || !isContinuityUuid(raw.id) || PRODUCT_PROFILE_KEYS.some(key =>
    typeof raw[key] !== "string" && !(["avatarShape", "avatarColor"].includes(key) && raw[key] === null))
    || !(raw.isGroup === undefined || typeof raw.isGroup === "boolean")) throw new NativeProductError("source_incomplete");
  let profile: ObservedProductProfile;
  try {
    const text = productProfile(Object.fromEntries(PRODUCT_PROFILE_KEYS.filter(k => raw[k] !== null).map(k => [k, raw[k]]))) as ProductProfile;
    profile = { ...text, avatarShape: raw.avatarShape === null ? null : text.avatarShape, avatarColor: raw.avatarColor === null ? null : text.avatarColor };
  } catch { throw new NativeProductError("source_incomplete"); }
  const kind = raw.isGroup === true ? "group" : "bot";
  if (kind === "group" && (!Array.isArray(raw.memberIds) || raw.memberIds.length > 64 || raw.memberIds.some(id => !isContinuityUuid(id)))) throw new NativeProductError("source_incomplete");
  const memberIds = kind === "group" ? (raw.memberIds as string[]).map(id => id.toLowerCase()).sort() : [];
  if (new Set(memberIds).size !== memberIds.length) throw new NativeProductError("source_incomplete");
  const value = { id: raw.id.toLowerCase(), kind, profile, memberIds,
    harness: raw.harness === "box" || raw.harness === "temporal" ? raw.harness : null,
    hidden: typeof raw.isHiddenFromSidebar === "boolean" ? raw.isHiddenFromSidebar : null,
    notify: typeof raw.notifyOnUpdatesEnabled === "boolean" ? raw.notifyOnUpdatesEnabled : null } satisfies Omit<ProductObject, "revision">;
  return { ...value, revision: sha256Text(canonicalJson(value)) };
}
export function productProfileAfter(intent: ProductIntent, target: ProductObject | null): Partial<ProductProfile> | null {
  if (intent.profile === null) return null;
  // Native roster null means no explicit avatar. Preserve it in reads, but
  // never send null to native .trim() or invent an empty avatar write.
  const before = Object.fromEntries(Object.entries(target?.profile ?? {}).filter(([, value]) => value !== null)) as Partial<ProductProfile>;
  const profile = { ...(intent.action === "update" ? before : {}), ...intent.profile };
  if (intent.kind === "bot" && intent.profile.title !== undefined) {
    const user = parseAgentTitle(intent.profile.title).user;
    profile.title = intent.action === "create" ? user : composeAgentTitle(target?.profile.title, { type: "set-user", user, owner: "leave" }).title;
  }
  return profile;
}
export function productEffects(intent: ProductIntent): string[] {
  if (intent.action === "duplicate") return ["native-profile-copy", "enabled-local-routine-copy", "future-routine-runs-may-incur-cost", "active-chat-change", "no-context-or-memory-copy", "target-harness-not-guaranteed", "no-managed-model-assignment-copy"];
  if (intent.action === "delete") return ["native-object-deletion", "native-schedule-and-box-release", ...(intent.kind === "bot" ? ["desktop-seat-cleanup"] : [])];
  if (intent.action === "create") return ["native-object-creation", ...(intent.kind === "bot" && !intent.deferStart ? ["native-startup-may-run"] : []), "active-chat-may-change"];
  return [intent.action === "members" ? "whole-membership-replacement" : "native-object-update"];
}
export function productPlan(intent: ProductIntent, snapshot: ProductSnapshot, duplicateRevision: string | null = null): ProductPlan {
  const target = intent.targetId === null ? null : snapshot.objects.find(o => o.id === intent.targetId && o.kind === intent.kind);
  if (target === undefined) throw new NativeProductError("not_found");
  if (intent.memberIds?.some(id => !snapshot.objects.some(o => o.id === id && o.kind === "bot"))) throw new NativeProductError("not_found");
  const memberRevision = intent.memberIds ? sha256Text(canonicalJson(snapshot.objects.filter(o => intent.memberIds!.includes(o.id)).map(o => [o.id, o.kind, o.harness]).sort())) : null;
  const binding = { policy: "native-product-v1", intent, scopeId: snapshot.authority.scopeId, sourceGeneration: snapshot.authority.generation,
    targetRevision: target?.revision ?? null, identityRevision: snapshot.authority.identityRevision, memberRevision, duplicateRevision,
    profileAfter: productProfileAfter(intent, target ?? null), effects: productEffects(intent) };
  return { intent, scopeId: binding.scopeId, revision: sha256Text(canonicalJson(binding)), sourceGeneration: binding.sourceGeneration,
    target: target ?? null, profileAfter: binding.profileAfter, memberRevision, duplicateRevision,
    atomicCompareAndSet: false, nativeIdempotency: "not-guaranteed", effects: binding.effects, nativeEffectsPerformed: false };
}
export function productResultMatches(intent: ProductIntent, current: ProductObject | null, previous: ProductObject | null = null): boolean {
  if (intent.action === "delete") return current === null;
  if (!current || current.kind !== intent.kind) return false;
  if (intent.action === "duplicate") return true; // Identity readback only, not copied contents or ownership.
  const profile = productProfileAfter(intent, previous);
  if (profile && Object.entries(profile).some(([k, v]) => current.profile[k as keyof ProductProfile] !== v)) return false;
  if (intent.harness !== null && current.harness !== intent.harness) return false;
  if (intent.memberIds && canonicalJson(current.memberIds) !== canonicalJson(intent.memberIds)) return false;
  if (intent.action === "hidden" && current.hidden !== intent.value || intent.action === "notify" && current.notify !== intent.value) return false;
  return true;
}
export function assertProductResult(raw: ProductResult): ProductResult {
  if (!object(raw) || Object.keys(raw).sort().join() !== "atomicCompareAndSet,cleanup,fullClone,nativeReceipt,object,readBack,relationshipsTransferred,targetId"
    || !["returned", "not-dispatched"].includes(raw.nativeReceipt) || !(raw.targetId === null || isContinuityUuid(raw.targetId))
    || !["matched", "mismatch", "not-observed"].includes(raw.readBack)
    || !["not-applicable", "native-lifecycle", "complete", "unavailable", "unknown"].includes(raw.cleanup)
    || raw.atomicCompareAndSet !== false || raw.relationshipsTransferred !== false || raw.fullClone !== false) throw new ContinuityFailure("integrity_failure");
  if (raw.nativeReceipt === "not-dispatched" && (raw.readBack !== "not-observed" || raw.object !== null || raw.cleanup !== "not-applicable")
    || raw.nativeReceipt === "returned" && raw.targetId === null
    || raw.readBack === "not-observed" && raw.object !== null) throw new ContinuityFailure("integrity_failure");
  if (raw.object !== null) {
    const v = raw.object;
    if (!object(v) || Object.keys(v).sort().join() !== "harness,hidden,id,kind,memberIds,notify,profile,revision" || v.id !== raw.targetId) throw new ContinuityFailure("integrity_failure");
    let checked: ProductObject;
    try { checked = productObject({ id: v.id, isGroup: v.kind === "group", ...v.profile, memberIds: v.memberIds, harness: v.harness, isHiddenFromSidebar: v.hidden, notifyOnUpdatesEnabled: v.notify }); }
    catch { throw new ContinuityFailure("integrity_failure"); }
    if (canonicalJson(checked) !== canonicalJson(v)) throw new ContinuityFailure("integrity_failure");
  }
  return raw;
}
export function assertProductDiagnostic(raw: ProductDiagnostic): ProductDiagnostic {
  if (!object(raw) || Object.keys(raw).sort().join() !== "code,detailStored,httpStatus,method,observedAtMs,phase"
    || !["native-call", "http-response", "response-body", "response-shape", "dispatch"].includes(raw.phase)
    || !["source_unavailable", "source_unauthorized", "source_timeout", "source_invalid", "source_changed", "unexpected_failure"].includes(raw.code)
    || !(raw.method === null || typeof raw.method === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw.method))
    || !(raw.httpStatus === null || Number.isSafeInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599)
    || !Number.isSafeInteger(raw.observedAtMs) || raw.observedAtMs < 1 || typeof raw.detailStored !== "boolean") throw new ContinuityFailure("integrity_failure");
  return raw;
}
export function assertProductReceipt(raw: ProductReceipt): ProductReceipt {
  if (!object(raw) || Object.keys(raw).sort().join() !== "createdAtMs,diagnostic,installationId,intent,operationId,planRevision,principalId,requestId,result,scopeId,state") throw new ContinuityFailure("integrity_failure");
  if (raw.diagnostic !== null) assertProductDiagnostic(raw.diagnostic);
  if (![raw.requestId, raw.operationId, raw.installationId].every(isContinuityUuid) || !isContinuityHash(raw.scopeId) || !isContinuityHash(raw.planRevision)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(raw.principalId) || canonicalJson(productIntent(raw.intent)) !== canonicalJson(raw.intent)
    || raw.intent.requestId !== raw.requestId || !["prepared", "effect_unknown", "complete"].includes(raw.state)
    || !Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs < 1 || (raw.state === "complete") !== (raw.result !== null)) throw new ContinuityFailure("integrity_failure");
  if (raw.result !== null) {
    const result = assertProductResult(raw.result), intent = raw.intent;
    const createsIdentity = intent.action === "create" || intent.action === "duplicate";
    if (createsIdentity ? result.nativeReceipt === "not-dispatched" ? result.targetId !== null
      : result.targetId === intent.targetId : result.targetId !== intent.targetId) throw new ContinuityFailure("integrity_failure");
    if (result.nativeReceipt === "returned") {
      if (intent.action !== "delete" && result.cleanup !== "not-applicable"
        || intent.action === "delete" && (intent.kind === "group" ? result.cleanup !== "native-lifecycle" : result.cleanup === "native-lifecycle")) throw new ContinuityFailure("integrity_failure");
      if (result.readBack === "matched") {
        if (!productResultMatches(intent, result.object, result.object)) throw new ContinuityFailure("integrity_failure");
      } else if (result.readBack === "mismatch" && intent.action === "delete" && result.object === null) throw new ContinuityFailure("integrity_failure");
    }
  }
  return raw;
}
