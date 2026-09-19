import { canonicalJson, sha256Text } from "../../hash.ts";
import { continuityObject, isContinuityUuid, isContinuityHash, isContinuityToken, failContinuity } from "./material.ts";
import { nativeCurrentHead, type NativeCurrentHead } from "./current-state.ts";
import { handoverPolicy, type HandoverPolicy } from "./handover.ts";

export type BotProfile = { name: string; description: string; title: string; avatarShape: string; avatarColor: string };
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.includes("\0") || new TextEncoder().encode(value).byteLength > max) return failContinuity("invalid_material");
  return value;
};
export function botProfile(raw: unknown): BotProfile {
  const v = continuityObject(raw, ["name", "description", "title", "avatarShape", "avatarColor"]);
  const name = text(v.name, 256);
  if (!name.trim()) return failContinuity("invalid_material");
  return { name, description: text(v.description ?? "", 32768), title: text(v.title ?? "", 1024),
    avatarShape: text(v.avatarShape ?? "", 128), avatarColor: text(v.avatarColor ?? "", 128) };
}
export type BotBirth = { operationId: string; scopeId: string; profile: BotProfile; instructions: string };
export function botBirth(raw: unknown): BotBirth {
  const v = continuityObject(raw, ["operationId", "scopeId", "profile", "instructions"]);
  if (!isContinuityUuid(v.operationId) || !isContinuityHash(v.scopeId)) return failContinuity("invalid_material");
  return { operationId: v.operationId, scopeId: v.scopeId, profile: botProfile(v.profile), instructions: text(v.instructions, 65536) };
}
export type BotWorkflowRequest = { version: 1; operationId: string; scopeId: string; kind: "clone" | "replace" | "spawn";
  sourceId: string | null; profile: BotProfile; modelRef: string | null; instructions: string; snapshotId: string | null;
  activate: boolean; start: boolean; maxRunMs: number; policyRevision: string;
  modelRevision?: string; effort?: string; sourceRevision?: string; handover?: HandoverPolicy;
  routineIntent?: Array<{id:string;enabled:boolean;definitionRevision:string;mutable:boolean}> };
export function botWorkflowRequest(raw: unknown): BotWorkflowRequest {
  const v = continuityObject(raw, ["version", "operationId", "scopeId", "kind", "sourceId", "profile", "modelRef", "instructions", "snapshotId", "activate", "start", "maxRunMs", "policyRevision", "modelRevision", "effort", "sourceRevision", "handover", "routineIntent"]);
  if (v.version !== 1 || !isContinuityUuid(v.operationId) || !isContinuityHash(v.scopeId) || !["clone", "replace", "spawn"].includes(String(v.kind))
    || !(v.sourceId === null || isContinuityUuid(v.sourceId)) || v.kind !== "spawn" && v.sourceId === null || v.kind === "spawn" && v.sourceId !== null
    || !(v.snapshotId === null || isContinuityUuid(v.snapshotId)) || !isContinuityHash(v.policyRevision)
    || typeof v.activate !== "boolean" || typeof v.start !== "boolean" || v.start && !v.activate
    || v.modelRevision !== undefined && !isContinuityHash(v.modelRevision) || v.sourceRevision !== undefined && !isContinuityHash(v.sourceRevision)
    || v.effort !== undefined && (typeof v.effort !== "string" || !/^[a-z0-9_-]{1,32}$/.test(v.effort))
    || !Number.isSafeInteger(v.maxRunMs) || Number(v.maxRunMs) < 1000 || Number(v.maxRunMs) > 180000) return failContinuity("invalid_material");
  let routineIntent: BotWorkflowRequest["routineIntent"];
  if(v.routineIntent!==undefined){
    if(!Array.isArray(v.routineIntent)||v.routineIntent.length>100)return failContinuity("invalid_material");
    routineIntent=v.routineIntent.map(raw=>{const row=continuityObject(raw,["id","enabled","definitionRevision","mutable"]);
      if(typeof row.id!=="string"||!isContinuityToken(row.id)||typeof row.enabled!=="boolean"||typeof row.mutable!=="boolean"||!isContinuityHash(row.definitionRevision))return failContinuity("invalid_material");
      return {id:row.id,enabled:row.enabled,definitionRevision:row.definitionRevision,mutable:row.mutable};});
  }
  return { version: 1, operationId: v.operationId, scopeId: v.scopeId, kind: v.kind as BotWorkflowRequest["kind"], sourceId: v.sourceId as string | null,
    profile: botProfile(v.profile), instructions: text(v.instructions, 65536), modelRef: v.modelRef === null ? null : text(v.modelRef, 512),
    snapshotId: v.snapshotId as string | null, activate: v.activate, start: v.start, maxRunMs: Number(v.maxRunMs), policyRevision: v.policyRevision,
    ...(v.modelRevision === undefined ? {} : { modelRevision: v.modelRevision as string }),
    ...(v.sourceRevision === undefined ? {} : { sourceRevision: v.sourceRevision as string }),
    ...(v.effort === undefined ? {} : { effort: v.effort as string }),
    ...(v.handover === undefined ? {} : { handover: handoverPolicy(v.handover) }), ...(routineIntent?{routineIntent}:{}) };
}
export type BotStartup = { operationId: string; expected: NativeCurrentHead; maxRunMs: number };
export function botStartup(raw: unknown): BotStartup {
  const v = continuityObject(raw, ["operationId", "expected", "maxRunMs"]);
  if (!isContinuityUuid(v.operationId) || !Number.isSafeInteger(v.maxRunMs) || Number(v.maxRunMs) < 1000 || Number(v.maxRunMs) > 180000) return failContinuity("invalid_material");
  return { operationId: v.operationId, expected: nativeCurrentHead(v.expected), maxRunMs: Number(v.maxRunMs) };
}
export const botWorkflowDigest = (request: BotWorkflowRequest) => sha256Text(canonicalJson(botWorkflowRequest(request)));
export const WORKFLOW_STEPS = ["capture", "create", "load", "model", "compose", "initialize", "activate", "startup", "handover"] as const;
export type WorkflowStep = typeof WORKFLOW_STEPS[number];
export type WorkflowReceipt = { operationId: string; kind: BotWorkflowRequest["kind"]; sourceId: string | null; targetId: string | null;
  phase: "prepared" | "progressing" | "ready" | "active" | "active_with_handover" | "blocked";
  steps: Array<{ step: WorkflowStep; state: "prepared" | "effect_unknown" | "complete"; result: Record<string, unknown> | null }>;
  policyRevision: string; createdAtMs: number; updatedAtMs: number };
