import { ManagementClientError, UUID, botIdFromRef, botRef } from "./contract.ts";
import { protectionReferenceIdentity } from "./protection-contract.ts";

export type LifecycleKind = "clone" | "replace" | "spawn";
export type LifecycleIntent = {
  requestId: string; kind: LifecycleKind; sourceBotRef: string | null;
  name?: string; description?: string; instructions: string; modelId?: string | null; effort?: string;
  snapshotRef: string | null; activate: boolean; start: boolean; maxRunMs: number; allowHandoverMessages: boolean;
};
export type LifecycleSubmission = LifecycleIntent & { scopeId: string; planRevision: string; confirmed: true };
export type LifecycleResume = { requestId: string; scopeId: string; planRevision: string; confirmed: true };
export type LifecyclePreview = {
  requestId: string; operationRef: string; scopeId: string; planRevision: string; kind: LifecycleKind;
  sourceBotRef: string | null; targetName: string; modelId: string | null; instructionsSha256: string;
  activate: boolean; start: boolean; maxRunMs: number; materialPolicy: "best-effort-with-gaps";
  planPersisted: false; nativeEffectsPerformed: false; sourceDeleted: false;
};
export const LIFECYCLE_PHASES = ["prepared", "progressing", "ready", "active", "active_with_handover", "blocked", "retired"] as const;
export const LIFECYCLE_STEPS = ["capture", "create", "load", "model", "compose", "initialize", "activate", "startup", "handover"] as const;
export type LifecycleOperation = {
  requestId: string; operationRef: string; scopeId: string; planRevision: string; kind: LifecycleKind;
  sourceBotRef: string | null; targetBotRef: string | null; state: typeof LIFECYCLE_PHASES[number];
  steps: { step: typeof LIFECYCLE_STEPS[number]; state: "effect_unknown" | "complete" }[];
  effectsUnknown: boolean; createdAtMs: number; updatedAtMs: number;
  requestedActivation: boolean; requestedStartup: boolean; handoverRef: string | null;
  currentTargetUsability: "not-observed"; sourceRetirement: "not-observed"; privateInputsIncluded: false;
};
export type LifecycleList = { operations: LifecycleOperation[]; scopeId: string | null; nextCursor: string | null; coverage: "retained-principal-workflows" };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(k => typeof k === "string" && "value" in Object.getOwnPropertyDescriptor(v, k)!);
const bad = (): never => { throw new ManagementClientError("invalid_input", "Use an exact lifecycle declaration, persisted request UUID and explicit reviewed plan; arbitrary native fields are not accepted."); };
const text = (v: unknown, max: number): v is string => typeof v === "string" && !v.includes("\0") && new TextEncoder().encode(v).length <= max;
const intentKeys = ["requestId", "kind", "sourceBotRef", "name", "description", "instructions", "modelId", "effort", "snapshotRef", "activate", "start", "maxRunMs", "allowHandoverMessages"];
export function normalizeLifecycleIntent(input: unknown, installationId: string): LifecycleIntent {
  if (!UUID.test(installationId)) throw new ManagementClientError("wrong_installation", "Pin the lifecycle request to an installation.");
  if (!object(input) || Object.keys(input).some(k => !intentKeys.includes(k)) || typeof input.requestId !== "string" || !UUID.test(input.requestId)
    || typeof input.kind !== "string" || !["clone", "replace", "spawn"].includes(input.kind)) return bad();
  const kind = input.kind as LifecycleKind, source = input.sourceBotRef ?? null;
  if (kind === "spawn" ? source !== null : typeof source !== "string") return bad();
  const sourceBotRef = source === null ? null : botRef(installationId, botIdFromRef(source as string, installationId));
  for (const [key, max] of [["name", 256], ["description", 16384], ["instructions", 32768]] as const) {
    if (input[key] !== undefined && !text(input[key], max)) return bad();
  }
  if (input.name !== undefined && (!(input.name as string).trim() || /[\x00-\x1f]/.test(input.name as string))) return bad();
  if (kind === "spawn" && input.name === undefined) return bad();
  if (input.modelId !== undefined && input.modelId !== null && (!text(input.modelId, 512) || !input.modelId.trim() || /[\x00-\x20]/.test(input.modelId))) return bad();
  if (input.effort !== undefined && (typeof input.effort !== "string" || !/^[a-z0-9_-]{1,32}$/.test(input.effort) || input.modelId === null)) return bad();
  for (const key of ["activate", "start", "allowHandoverMessages"]) if (input[key] !== undefined && typeof input[key] !== "boolean") return bad();
  const start = input.start ?? kind === "spawn", activate = input.activate ?? (kind !== "clone" || start === true);
  if (start && !activate || kind === "spawn" && (!start || !activate) || kind === "replace" && !activate
    || kind !== "replace" && input.allowHandoverMessages === true) return bad();
  const maxRunMs = input.maxRunMs ?? 180000;
  if (!Number.isSafeInteger(maxRunMs) || Number(maxRunMs) < 1000 || Number(maxRunMs) > 180000) return bad();
  let snapshotRef: string | null = null;
  if (input.snapshotRef !== undefined && input.snapshotRef !== null) {
    if (kind === "spawn" || typeof input.snapshotRef !== "string") return bad();
    snapshotRef = protectionReferenceIdentity(input.snapshotRef, installationId, "snapshot").ref;
  }
  return { requestId: input.requestId.toLowerCase(), kind, sourceBotRef, instructions: (input.instructions ?? "") as string,
    ...(input.name === undefined ? {} : { name: input.name as string }), ...(input.description === undefined ? {} : { description: input.description as string }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId as string | null }), ...(input.effort === undefined ? {} : { effort: input.effort as string }),
    snapshotRef, activate: activate as boolean, start: start as boolean, maxRunMs: Number(maxRunMs), allowHandoverMessages: input.allowHandoverMessages === true };
}
export function normalizeLifecycleResume(input: unknown): LifecycleResume {
  if (!object(input) || Object.keys(input).some(k => !["requestId", "scopeId", "planRevision", "confirmed"].includes(k))
    || typeof input.requestId !== "string" || !UUID.test(input.requestId) || !hash(input.scopeId) || !hash(input.planRevision) || input.confirmed !== true) return bad();
  return { requestId: input.requestId.toLowerCase(), scopeId: input.scopeId, planRevision: input.planRevision, confirmed: true };
}
export function normalizeLifecycleSubmission(input: unknown, installationId: string): LifecycleSubmission {
  if (!object(input)) return bad();
  const { scopeId, planRevision, confirmed, ...declaration } = input;
  const intent = normalizeLifecycleIntent(declaration, installationId);
  return { ...intent, ...normalizeLifecycleResume({ requestId: intent.requestId, scopeId, planRevision, confirmed }) };
}
export function lifecycleReference(installationId: string, scopeId: string, requestId: string): string {
  if (!UUID.test(installationId) || !hash(scopeId) || !UUID.test(requestId)) return bad();
  return `lifecycle:${installationId.toLowerCase()}:${scopeId}:${requestId.toLowerCase()}`;
}
export function lifecycleIdentity(ref: string, installationId: string) {
  if (!UUID.test(installationId)) throw new ManagementClientError("wrong_installation", "Pin this installation before reading a lifecycle operation.");
  const parts = typeof ref === "string" ? ref.split(":") : [];
  if (parts.length !== 4 || parts[0] !== "lifecycle" || !UUID.test(parts[1]!) || !hash(parts[2]) || !UUID.test(parts[3]!)) return bad();
  if (parts[1]!.toLowerCase() !== installationId.toLowerCase()) throw new ManagementClientError("wrong_installation", "This lifecycle belongs to another installation.");
  return { scopeId: parts[2]!, requestId: parts[3]!.toLowerCase(), ref: lifecycleReference(installationId, parts[2]!, parts[3]!) };
}
