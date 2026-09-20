import { ManagementClientError, UUID, botIdFromRef, botRef } from "./contract.ts";
import type { BotProtection } from "@grokbox/runtime-kernel/continuity";
export type { BotProtection };
export type ProtectionPatch = Partial<Omit<BotProtection,"handover">> & { handover?: Partial<BotProtection["handover"]> };
export type ProtectionChangeRequest = { requestId: string; expectedRevision: string; confirmed: true } & (
  { action: "system"; enabled: boolean } | { action: "set"; botRef: string; patch: ProtectionPatch } | { action: "reset"; botRef: string });
export type ProtectionOperation = { requestId: string; operationRef: string; targetRef: string; state: "succeeded" | "unknown";
  beforeRevision: string; revision: string | null; application: "not-observed"; nativeEffectsPerformed: false };
export type ProtectionWorkerView = {
  owner: "management-server"; state: "starting" | "disabled" | "idle" | "running" | "blocked" | "stopping" | "stopped";
  reason: string; scopeId: string | null; scopeObservedAtMs: number | null; policyRevision: string | null;
  targets: number; discovered: number; rosterSize: number; discoveryCoverage: "not-observed" | "rotating-batch" | "observed-window" | "capacity-limited" | "creation-pending";
  startedAtMs: number; replacements: number; defaultProtection: true; nativeExecutionProven: false; bootInstalled: false;
};
export type ProtectionSubject = { botRef: string; currentBotRef: string; previousBotRefs: string[]; generation: number; revision: number;
  ownership: "box" | "temporal" | "conflict" | "gap" | null; observedAtMs: number | null; freshness: "fresh" | "stale" | "not-observed";
  lossId: string | null; lossAtMs: number | null; lastSnapshotRef: string | null; capturedAtMs: number | null; pendingHandoverRef: string | null;
  handoverRefs: string[]; handoverHistoryTruncated: boolean;
  lastAction: string | null; pause: { complete: boolean; remaining: number; failed: number } | null;
  eventExportPending: boolean; eventExportDropped: number; notificationDelivery: "not-observed" };
export type ProtectionOverview = { revision: string; enabled: boolean; intervalMs: number; defaultPolicy: BotProtection;
  worker: ProtectionWorkerView; store: "not-initialized" | "observed" | "unavailable"; scopeId: string | null;
  subjects: ProtectionSubject[]; hasMore: boolean; overrides: { botRef: string; policy: BotProtection }[]; currentOwnershipProven: false };
export type ProtectionBotView = { revision: string; enabled: boolean; botRef: string; policy: BotProtection; policySource: "default" | "override";
  subject: ProtectionSubject | null; store: ProtectionOverview["store"]; scopeId: string | null; protectionApplied: "not-observed" };
export type ProtectionSnapshot = { snapshotRef: string; botRef: string; revision: string; state: "reserved" | "published" | "abandoned" | "retired";
  quality: string; capturedAtMs: number; contentIncluded: false; nativeImportProven: false };
export type ProtectionSnapshotList = { botRef: string; scopeId: string | null; snapshots: ProtectionSnapshot[]; hasMore: boolean; coverage: "retained-metadata" };
export type ProtectionHandover = { handoverRef: string; sourceBotRef: string | null; targetBotRef: string | null; phase: string; kind: "clone" | "replace" | "spawn";
  createdAtMs: number; updatedAtMs: number; steps: { step: string; state: "effect_unknown" | "complete" }[];
  duties: { itemId: string; kind: string; state: "prepared" | "effect_unknown" | "complete" | "blocked"; evidenceRecorded: boolean }[];
  remaining: number; unknown: number; complete: number; moreDuties: boolean; targetUsability: "not-observed"; retirementEligibility: "not-observed"; privateInputsIncluded: false };
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(k=>typeof k==="string" && "value" in Object.getOwnPropertyDescriptor(v,k)!);
const bad = (): never => { throw new ManagementClientError("invalid_input","Protection changes require explicit consent, a fixed target, revision and bounded policy fields."); };
const range = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v)>=min && Number(v)<=max;
const botKeys = ["enabled","mode","tier","pauseOnOwnershipLoss","captureIntervalMs","maxReplacementsPerDay","cooldownMs","handover"];
const handoverKeys = ["routines","groups","directMessages","oldBotAssistance","titles","sidebar","allowUserMessages","automaticDelete","minGraceMs","quietMs"];
/** Input and wire-shape check only. The domain's existing policy program owns
 * defaults, effective configuration and admission to actual native effects. */
export function validProtectionPatch(v: unknown, complete = false): v is ProtectionPatch {
  if (!object(v) || Object.keys(v).some(k=>!botKeys.includes(k)) || complete && botKeys.some(k=>!Object.hasOwn(v,k))) return false;
  if (Object.hasOwn(v,"enabled") && typeof v.enabled!=="boolean" || Object.hasOwn(v,"pauseOnOwnershipLoss") && typeof v.pauseOnOwnershipLoss!=="boolean"
    || Object.hasOwn(v,"mode") && !["alert","prepare","auto-replace"].includes(String(v.mode)) || Object.hasOwn(v,"tier") && !["observe","memory","resume","archive"].includes(String(v.tier))
    || Object.hasOwn(v,"captureIntervalMs") && !range(v.captureIntervalMs,10000,86400000) || Object.hasOwn(v,"cooldownMs") && !range(v.cooldownMs,60000,86400000)
    || Object.hasOwn(v,"maxReplacementsPerDay") && !range(v.maxReplacementsPerDay,0,16)) return false;
  if (Object.hasOwn(v,"handover")) {
    const h=v.handover;
    if (!object(h) || Object.keys(h).some(k=>!handoverKeys.includes(k)) || complete && handoverKeys.some(k=>!Object.hasOwn(h,k))) return false;
    if (Object.keys(h).some(k=>k==="routines" ? !["move","keep-source"].includes(String(h[k])) : ["minGraceMs","quietMs"].includes(k) ? !range(h[k],60000,90*86400000) : typeof h[k]!=="boolean")) return false;
  }
  return true;
}
export function normalizeProtectionChange(input: unknown, installationId: string): ProtectionChangeRequest {
  if (!UUID.test(installationId)) throw new ManagementClientError("wrong_installation","Pin the protection request to this installation.");
  if (!object(input)) return bad();
  const keys = ["requestId","expectedRevision","confirmed","action",...(input.action==="system"?["enabled"]:input.action==="set"?["botRef","patch"]:["botRef"])];
  if (Object.keys(input).some(k=>!keys.includes(k)) || typeof input.requestId!=="string" || !UUID.test(input.requestId)
    || typeof input.expectedRevision!=="string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision) || input.confirmed!==true || !["system","set","reset"].includes(String(input.action))) return bad();
  const common = {requestId:input.requestId.toLowerCase(),expectedRevision:input.expectedRevision,confirmed:true as const};
  if (input.action==="system") { if(typeof input.enabled!=="boolean")return bad();return {...common,action:"system",enabled:input.enabled}; }
  const ref=botRef(installationId,botIdFromRef(String(input.botRef??""),installationId));
  if(input.action==="reset")return {...common,action:"reset",botRef:ref};
  if(!validProtectionPatch(input.patch)||!Object.keys(input.patch).length)return bad();
  return {...common,action:"set",botRef:ref,patch:structuredClone(input.patch)};
}
export function protectionReference(kind: "snapshot" | "handover", installationId: string, scopeId: string, id: string) {
  if(!UUID.test(installationId)||!/^[a-f0-9]{64}$/.test(scopeId)||!UUID.test(id))return bad();
  return `${kind}:${installationId.toLowerCase()}:${scopeId}:${id.toLowerCase()}`;
}
export function protectionReferenceIdentity(ref: string, installationId: string, kind: "snapshot" | "handover") {
  if(!UUID.test(installationId))throw new ManagementClientError("wrong_installation","Pin the reference before reading protection history.");
  const p=typeof ref==="string"?ref.split(":"):[];
  if(p.length!==4||p[0]!==kind||!UUID.test(p[1]!)||!/^[a-f0-9]{64}$/.test(p[2]!)||!UUID.test(p[3]!))return bad();
  if(p[1]!.toLowerCase()!==installationId.toLowerCase())throw new ManagementClientError("wrong_installation","This protection reference belongs to another installation.");
  return {scopeId:p[2]!,id:p[3]!.toLowerCase(),ref:protectionReference(kind,installationId,p[2]!,p[3]!)};
}
