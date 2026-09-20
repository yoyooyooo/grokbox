import { ManagementClientError, UUID, botIdFromRef, botRef } from "./contract.ts";
import { protectionReferenceIdentity } from "./protection-contract.ts";

export type ContextAction = "capture" | "initialize" | "reset" | "restore";
export type ContextChange = { requestId: string; botRef: string; scopeId: string; expectedRevision: string; confirmed: true } &
  ({ action: "capture" | "reset" } | { action: "initialize" | "restore"; snapshotRef: string });
export type ContextContinuation = { requestId: string; botRef: string; scopeId: string; confirmed: true } &
  ({ action: "resume" | "reconcile" | "cancel" } | { action: "activate"; expectedRevision: string });
export type ContextView = { botRef: string; scopeId: string; revision: string; policyRevision: string; hostSourceSha: string;
  nativeSchema: string; hostGeneration: string; state: "empty" | "prepared" | "active" | "interrupted";
  effects: "clear" | "unresolved"; hasCheckpoint: boolean; observedAtMs: number; contentIncluded: false; currentOwnershipProven: false };
export type ContextOperation = { requestId: string; operationRef: string; botRef: string; scopeId: string; action: ContextAction;
  expectedRevision: string; state: "admitted" | "unknown" | "captured" | "prepared" | "released" | "cancelled";
  captureRef: string | null; backupRef: string | null; candidateRef: string | null;
  application: "not-recorded" | "prepared" | "effect-unknown" | "succeeded" | "not-executed";
  activation: "not-requested" | "prepared" | "unknown" | "released"; activationExpectedRevision: string | null; createdAtMs: number;
  sourceBodyIncluded: false; startedTask: false; currentTargetUsability: "not-observed" };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(k => typeof k === "string" && "value" in Object.getOwnPropertyDescriptor(v, k)!);
const bad = (): never => { throw new ManagementClientError("invalid_input", "Use one original context request, exact Bot/scope/revision and explicit confirmation; no arbitrary native input is accepted."); };
function identity(v: Record<string, unknown>, installationId: string) {
  if (!UUID.test(installationId)) throw new ManagementClientError("wrong_installation", "Pin this context operation to an installation.");
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId) || typeof v.botRef !== "string" || !hash(v.scopeId) || v.confirmed !== true) return bad();
  return { requestId: v.requestId.toLowerCase(), botRef: botRef(installationId, botIdFromRef(v.botRef, installationId)), scopeId: v.scopeId, confirmed: true as const };
}
export function normalizeContextChange(raw: unknown, installationId: string): ContextChange {
  if (!object(raw) || typeof raw.action !== "string" || !["capture", "initialize", "reset", "restore"].includes(raw.action)) return bad();
  const usesMaterial = raw.action === "initialize" || raw.action === "restore";
  if (Object.keys(raw).some(k => !["requestId", "botRef", "scopeId", "expectedRevision", "confirmed", "action", ...(usesMaterial ? ["snapshotRef"] : [])].includes(k)) || !hash(raw.expectedRevision)) return bad();
  const common = { ...identity(raw, installationId), expectedRevision: raw.expectedRevision };
  if (!usesMaterial) return { ...common, action: raw.action as "capture" | "reset" };
  if (typeof raw.snapshotRef !== "string") return bad();
  const snapshot = protectionReferenceIdentity(raw.snapshotRef, installationId, "snapshot");
  if (snapshot.scopeId !== common.scopeId) return bad();
  return { ...common, action: raw.action as "initialize" | "restore", snapshotRef: snapshot.ref };
}
export function normalizeContextContinuation(raw: unknown, installationId: string): ContextContinuation {
  if (!object(raw) || typeof raw.action !== "string" || !["resume", "reconcile", "activate", "cancel"].includes(raw.action)) return bad();
  if (Object.keys(raw).some(k => !["requestId", "botRef", "scopeId", "confirmed", "action", ...(raw.action === "activate" ? ["expectedRevision"] : [])].includes(k))) return bad();
  const common = identity(raw, installationId);
  if (raw.action !== "activate") return { ...common, action: raw.action as "resume" | "reconcile" | "cancel" };
  if (!hash(raw.expectedRevision)) return bad();
  return { ...common, action: "activate", expectedRevision: raw.expectedRevision };
}
export function contextOperationRef(installationId: string, scopeId: string, requestId: string): string {
  if (!UUID.test(installationId) || !hash(scopeId) || !UUID.test(requestId)) return bad();
  return `context-operation:${installationId.toLowerCase()}:${scopeId}:${requestId.toLowerCase()}`;
}
export function contextOperationIdentity(ref: string, installationId: string) {
  const parts = typeof ref === "string" ? ref.split(":") : [];
  if (parts.length !== 4 || parts[0] !== "context-operation" || !UUID.test(parts[1]!) || !hash(parts[2]) || !UUID.test(parts[3]!)) return bad();
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "This context operation belongs to another installation.");
  return { scopeId: parts[2]!, requestId: parts[3]!.toLowerCase(), ref: contextOperationRef(installationId, parts[2]!, parts[3]!) };
}
