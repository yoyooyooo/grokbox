import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { productIntent, productSubmission, productProfileAfter, productEffects, assertProductReceipt, assertProductResult, NativeProductError,
  type ProductIntent, type ProductSubmission, type ProductPlan, type ProductReceipt, type ProductObject,
  type ProductOwnership, type ProductRelations } from "@grokbox/runtime-kernel/continuity";
import { ManagementClientError, UUID } from "./contract.ts";
export type { ProductIntent, ProductSubmission, ProductPlan, ProductReceipt, ProductObject, ProductOwnership, ProductRelations };
export type ProductView = ProductObject & { ref: string };
export type ProductList = { objects: ProductView[]; scopeId: string; sourceGeneration: string; revision: string;
  total: number; nextCursor: string | null; pageBound: "count" | "bytes" | null; coverage: "current-native-roster" };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).sort().join() === [...names].sort().join();
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const text = (v: unknown, n: number): v is string => typeof v === "string" && v.length > 0 && v.length <= n;
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const failure = (): never => { throw new ManagementClientError("invalid_input", "Use a strict native product intent and its original reviewed scope and revision."); };
export function normalizeProductIntent(raw: unknown): ProductIntent {
  try { return productIntent(raw); } catch (error) { if (error instanceof NativeProductError) return failure(); throw error; }
}
export function normalizeProductSubmission(raw: unknown): ProductSubmission {
  try { return productSubmission(raw); } catch (error) { if (error instanceof NativeProductError) return failure(); throw error; }
}
export function productReference(kind: "bot" | "group", installationId: string, nativeId: string): string {
  if (!id(installationId) || !id(nativeId)) return failure();
  return `${kind}:${installationId.toLowerCase()}:${nativeId.toLowerCase()}`;
}
export function productIdentity(raw: string, kind: "bot" | "group", installationId: string): string {
  if (UUID.test(raw)) return raw.toLowerCase();
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== kind || !id(parts[1]) || !id(parts[2])) return failure();
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "This native product reference belongs to another installation.");
  return parts[2]!.toLowerCase();
}
export function productOperationIdentity(raw: unknown): { scopeId: string; requestId: string } {
  if (!record(raw) || !keys(raw, ["scopeId", "requestId"]) || !hash(raw.scopeId) || !id(raw.requestId)) return failure();
  return { scopeId: raw.scopeId, requestId: raw.requestId.toLowerCase() };
}
function validObject(value: unknown): value is ProductObject {
  if (!record(value) || !id(value.id) || !hash(value.revision)) return false;
  try {
    assertProductResult({ nativeReceipt: "returned", targetId: value.id, readBack: "matched", object: value as ProductObject,
      cleanup: "not-applicable", atomicCompareAndSet: false, relationshipsTransferred: false, fullClone: false });
    return true;
  } catch { return false; }
}
export function productPlanView(value: unknown, intent: ProductIntent): value is ProductPlan {
  if (!record(value) || !keys(value, ["intent", "scopeId", "revision", "sourceGeneration", "target", "profileAfter", "memberRevision", "duplicateRevision", "atomicCompareAndSet", "nativeIdempotency", "effects", "nativeEffectsPerformed"])) return false;
  try {
    if (canonicalJson(productIntent(value.intent)) !== canonicalJson(intent)) return false;
  } catch { return false; }
  return hash(value.scopeId) && hash(value.revision) && hash(value.sourceGeneration)
    && (intent.targetId === null ? value.target === null : validObject(value.target) && value.target.id === intent.targetId && value.target.kind === intent.kind)
    && (intent.memberIds === null ? value.memberRevision === null : hash(value.memberRevision))
    && (intent.action === "duplicate" ? hash(value.duplicateRevision) : value.duplicateRevision === null)
    && value.atomicCompareAndSet === false && value.nativeIdempotency === "not-guaranteed" && value.nativeEffectsPerformed === false
    && canonicalJson(value.profileAfter) === canonicalJson(productProfileAfter(intent, value.target as ProductObject | null))
    && canonicalJson(value.effects) === canonicalJson(productEffects(intent));
}
export function productReceiptView(value: unknown, installationId: string, scopeId: string, requestId: string, request?: ProductSubmission): value is ProductReceipt {
  if (!record(value) || value.installationId !== installationId || value.scopeId !== scopeId || value.requestId !== requestId) return false;
  try {
    const row = assertProductReceipt(value as ProductReceipt);
    if (request) {
      const { scopeId: _scope, expectedRevision, confirmed: _confirmed, acceptNonAtomic: _nonAtomic, ...intent } = request;
      if (row.planRevision !== expectedRevision || canonicalJson(row.intent) !== canonicalJson(productIntent(intent))) return false;
    }
    return true;
  } catch { return false; }
}
export function productListView(value: unknown, installationId: string, limit: number, kind?: "bot" | "group", targetId?: string): value is ProductList {
  if (!record(value) || !keys(value, ["objects", "scopeId", "sourceGeneration", "revision", "total", "nextCursor", "pageBound", "coverage"])
    || !hash(value.scopeId) || !hash(value.sourceGeneration) || !hash(value.revision) || !uint(value.total)
    || value.coverage !== "current-native-roster" || ![null, "count", "bytes"].includes(value.pageBound as never)
    || !(value.nextCursor === null || text(value.nextCursor, 2048)) || !Array.isArray(value.objects) || value.objects.length > limit || value.total < value.objects.length) return false;
  const ids: string[] = [];
  for (const raw of value.objects) {
    if (!record(raw)) return false;
    const { ref, ...object } = raw;
    if (!validObject(object) || ref !== productReference(object.kind, installationId, object.id) || kind !== undefined && object.kind !== kind || targetId !== undefined && object.id !== targetId) return false;
    ids.push(object.id);
  }
  return new Set(ids).size === ids.length;
}
export function productOwnershipView(value: unknown, targetId: string): value is ProductOwnership {
  if (!record(value) || !keys(value, ["scopeId", "sourceGeneration", "observedAtMs", "agents", "coverage", "executionQualified"])
    || !hash(value.scopeId) || !hash(value.sourceGeneration) || !uint(value.observedAtMs) || value.observedAtMs === 0
    || value.coverage !== "requested-native-registration" || value.executionQualified !== false || !Array.isArray(value.agents) || value.agents.length !== 1) return false;
  const row = value.agents[0];
  return record(row) && keys(row, ["id", "state", "serverId", "viewerIsOwner"]) && row.id === targetId
    && ["confirmed_box", "confirmed_temporal", "conflict", "unconfirmed"].includes(String(row.state))
    && (row.serverId === null || text(row.serverId, 128)) && (row.viewerIsOwner === null || typeof row.viewerIsOwner === "boolean");
}
export function productRelationsView(value: unknown, botId: string): value is ProductRelations {
  if (!record(value) || !keys(value, ["botId", "scopeId", "sourceGeneration", "observedAtMs", "groups", "groupsTruncated", "transcript", "routines", "currentRosterCoverage", "externalTasksEnumerated"])
    || value.botId !== botId || !hash(value.scopeId) || !hash(value.sourceGeneration) || !uint(value.observedAtMs) || value.observedAtMs === 0
    || value.currentRosterCoverage !== "native-snapshot" || value.externalTasksEnumerated !== false || typeof value.groupsTruncated !== "boolean"
    || !Array.isArray(value.groups) || value.groups.length > 128) return false;
  for (const g of value.groups) if (!record(g) || !keys(g, ["id", "memberIds", "revision"]) || !id(g.id) || !hash(g.revision)
    || !Array.isArray(g.memberIds) || g.memberIds.length > 64 || !g.memberIds.every(id) || !g.memberIds.includes(botId) || new Set(g.memberIds).size !== g.memberIds.length) return false;
  const t = value.transcript, r = value.routines;
  if (!record(t) || !keys(t, ["state", "returnedEntries", "peerIds", "inbound", "coverage", "complete"]) || !["observed", "unavailable"].includes(String(t.state))
    || t.coverage !== "bounded-native-peer-fields" || t.complete !== false || !uint(t.returnedEntries) || t.returnedEntries > 200
    || !Array.isArray(t.peerIds) || t.peerIds.length > 200 || !t.peerIds.every(id) || !Array.isArray(t.inbound) || t.inbound.length > 200) return false;
  for (const e of t.inbound) if (!record(e) || !keys(e, ["id", "requestId", "fromBotId", "toBotId"]) || !text(e.id, 256)
    || !(e.requestId === null || text(e.requestId, 256)) || !id(e.fromBotId) || !(e.toBotId === null || id(e.toBotId))) return false;
  if (!record(r) || !keys(r, ["state", "items", "coverage", "complete"]) || !["observed", "unavailable"].includes(String(r.state))
    || r.coverage !== "native-returned-window" || r.complete !== false || !Array.isArray(r.items) || r.items.length > 100) return false;
  return r.items.every(row => record(row) && keys(row, ["id", "revision", "enabled", "mutable"]) && text(row.id, 256) && hash(row.revision)
    && typeof row.enabled === "boolean" && typeof row.mutable === "boolean");
}
