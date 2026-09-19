import { canonicalJson, sha256Text } from "../../hash.ts";
import { continuityObject, isContinuityUuid, isContinuityHash, failContinuity } from "./material.ts";

export type HandoverPolicy = { routines: "move" | "keep-source"; groups: boolean; directMessages: boolean; oldBotAssistance: boolean;
  titles: boolean; sidebar: boolean; allowUserMessages: boolean; automaticDelete: boolean; minGraceMs: number; quietMs: number };
export const DEFAULT_HANDOVER: HandoverPolicy = Object.freeze({ routines: "move", groups: true, directMessages: true,
  oldBotAssistance: true, titles: true, sidebar: true, allowUserMessages: false, automaticDelete: false,
  minGraceMs: 7 * 86400000, quietMs: 3 * 86400000 });
export function handoverPolicy(raw: unknown = {}): HandoverPolicy {
  const v = continuityObject(raw, Object.keys(DEFAULT_HANDOVER)), out = { ...DEFAULT_HANDOVER, ...v } as HandoverPolicy;
  if (!["move", "keep-source"].includes(out.routines)) return failContinuity("invalid_material");
  for (const key of ["groups", "directMessages", "oldBotAssistance", "titles", "sidebar", "allowUserMessages", "automaticDelete"] as const) if (typeof out[key] !== "boolean") return failContinuity("invalid_material");
  for (const key of ["minGraceMs", "quietMs"] as const) if (!Number.isSafeInteger(out[key]) || out[key] < 60000 || out[key] > 90 * 86400000) return failContinuity("invalid_material");
  return out;
}
export type HandoverKind = "old-guidance" | "title-old" | "title-new" | "sidebar" | "group-notice" | "group-members" | "dm-notice" | "routine-create" | "routine-stop" | "routine-enable" | "external-task";
export const HANDOVER_KINDS: readonly HandoverKind[] = ["old-guidance", "title-old", "title-new", "sidebar", "group-notice", "group-members", "dm-notice", "routine-create", "routine-stop", "routine-enable", "external-task"];
export type HandoverPlanItem = { itemId: string; kind: HandoverKind; dependsOn: string[]; input: Record<string, unknown> };
export type InboundWatermark = { version: 1; cursor: string | null; lastObservedAtMs: number; healthySinceMs: number | null;
  lastActivityAtMs: number | null; newMessages: number; gap: boolean; coverage: "complete" | "partial" };
export function recordInbound(previous: InboundWatermark | null, sample: { cursor: string | null; observedAtMs: number; newMessages: number; contiguous: boolean }): InboundWatermark {
  if (!(sample.cursor === null || isContinuityHash(sample.cursor)) || !Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs < 1
    || !Number.isSafeInteger(sample.newMessages) || sample.newMessages < 0 || sample.newMessages > 4096 || typeof sample.contiguous !== "boolean") return failContinuity("invalid_material");
  const movedBack = previous !== null && sample.observedAtMs < previous.lastObservedAtMs;
  const gap = !sample.contiguous || movedBack || previous !== null && sample.observedAtMs - previous.lastObservedAtMs > 120000;
  return { version: 1, cursor: sample.cursor ?? previous?.cursor ?? null, lastObservedAtMs: sample.observedAtMs,
    healthySinceMs: gap ? null : previous?.healthySinceMs ?? sample.observedAtMs,
    lastActivityAtMs: sample.newMessages > 0 ? sample.observedAtMs : previous?.lastActivityAtMs ?? null,
    newMessages: sample.newMessages, gap, coverage: gap ? "partial" : "complete" };
}
export function assessRetirement(input: { policy: HandoverPolicy; nowMs: number; createdAtMs: number; inbound: InboundWatermark | null;
  remaining: number; unknown: number; targetUsable: boolean; dependenciesVerified: boolean; resourcesIndependent: boolean; deletionFenceAvailable: boolean }) {
  const policy = handoverPolicy(input.policy), blockers: string[] = [];
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.createdAtMs) || input.nowMs < input.createdAtMs) blockers.push("clock_invalid");
  if (input.nowMs - input.createdAtMs < policy.minGraceMs) blockers.push("grace_period");
  const w = input.inbound;
  if (!w || w.gap || w.coverage !== "complete" || w.healthySinceMs === null || input.nowMs - w.lastObservedAtMs > 120000 || input.nowMs < w.lastObservedAtMs) blockers.push("inbound_coverage_gap");
  else if (input.nowMs - Math.max(w.healthySinceMs, w.lastActivityAtMs ?? w.healthySinceMs) < policy.quietMs) blockers.push("quiet_period");
  if (input.remaining) blockers.push("unhandled_items"); if (input.unknown) blockers.push("unknown_effects");
  if (!input.targetUsable) blockers.push("target_unavailable");
  if (!input.dependenciesVerified) blockers.push("external_dependencies_unverified");
  if (!input.resourcesIndependent) blockers.push("source_resources_still_referenced");
  if (!input.deletionFenceAvailable) blockers.push("deletion_boundary_unavailable");
  return { eligible: blockers.length === 0, automaticDeleteAuthorized: policy.automaticDelete && blockers.length === 0, blockers };
}
/** Only typed peer identities from native transcript fields, never UUID text
 * mining. An incomplete history window is not a complete relationship graph. */
export function discoverPeers(entries: readonly Record<string, unknown>[], sourceId: string, excluded: readonly string[] = []): string[] {
  if (!isContinuityUuid(sourceId) || entries.length > 1024) return failContinuity("invalid_material");
  const peers = new Set<string>();
  for (const entry of entries) for (const field of ["fromAgent", "toAgent"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(entry, field);
    if (!descriptor || !("value" in descriptor)) continue;
    const peer = descriptor.value;
    const id = peer && typeof peer === "object" ? Object.getOwnPropertyDescriptor(peer, "id") : undefined;
    if (id && "value" in id && isContinuityUuid(id.value) && id.value !== sourceId && !excluded.includes(id.value)) peers.add(id.value);
  }
  return [...peers].sort();
}
export const handoverItemId = (operationId: string, kind: HandoverKind, target: string) => {
  const h = sha256Text(canonicalJson([operationId, kind, target])); return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
