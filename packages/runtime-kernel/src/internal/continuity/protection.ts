import { canonicalJson, sha256Text } from "../../hash.ts";
import { continuityObject, isContinuityUuid, failContinuity } from "./material.ts";
import { handoverPolicy, type HandoverPolicy } from "./handover.ts";

export type BotProtection = { enabled: boolean; mode: "alert" | "prepare" | "auto-replace"; tier: "observe" | "memory" | "resume" | "archive";
  pauseOnOwnershipLoss: boolean; captureIntervalMs: number; maxReplacementsPerDay: number; cooldownMs: number; handover: HandoverPolicy };
export type ContinuityProtection = { enabled: boolean; intervalMs: number; bots: Record<string, BotProtection> };
const DEFAULT_BOT: Omit<BotProtection, "handover"> = { enabled: true, mode: "alert", tier: "resume", pauseOnOwnershipLoss: true,
  captureIntervalMs: 60000, maxReplacementsPerDay: 3, cooldownMs: 300000 };
export function botProtection(raw: unknown = {}): BotProtection {
  const value = continuityObject(raw, [...Object.keys(DEFAULT_BOT), "handover"]), v = { ...DEFAULT_BOT, ...value };
  if (typeof v.enabled !== "boolean" || typeof v.pauseOnOwnershipLoss !== "boolean" || !["alert", "prepare", "auto-replace"].includes(String(v.mode))
    || !["observe", "memory", "resume", "archive"].includes(String(v.tier)) || !Number.isSafeInteger(v.captureIntervalMs) || Number(v.captureIntervalMs) < 10000 || Number(v.captureIntervalMs) > 86400000
    || !Number.isSafeInteger(v.maxReplacementsPerDay) || Number(v.maxReplacementsPerDay) < 0 || Number(v.maxReplacementsPerDay) > 16
    || !Number.isSafeInteger(v.cooldownMs) || Number(v.cooldownMs) < 60000 || Number(v.cooldownMs) > 86400000) return failContinuity("invalid_material");
  return { ...v, handover: handoverPolicy(value.handover) } as BotProtection;
}
export function continuityProtection(raw: unknown = {}): ContinuityProtection {
  const value = continuityObject(raw, ["enabled", "intervalMs", "bots"]), enabled = value.enabled ?? false, intervalMs = value.intervalMs ?? 30000;
  if (typeof enabled !== "boolean" || !Number.isSafeInteger(intervalMs) || Number(intervalMs) < 10000 || Number(intervalMs) > 300000) return failContinuity("invalid_material");
  const map = value.bots ?? {};
  if (!map || typeof map !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(map)) || Reflect.ownKeys(map).length > 128) return failContinuity("invalid_material");
  const bots: Record<string, BotProtection> = Object.create(null);
  for (const id of Reflect.ownKeys(map)) {
    if (!isContinuityUuid(id)) return failContinuity("invalid_material");
    const descriptor = Object.getOwnPropertyDescriptor(map, id)!;
    if (!("value" in descriptor)) return failContinuity("invalid_material");
    bots[id] = botProtection(descriptor.value);
  }
  return { enabled, intervalMs: Number(intervalMs), bots };
}
export const protectionRevision = (logicalId: string, policy: BotProtection) => sha256Text(canonicalJson([logicalId, botProtection(policy)]));
export function replacementBudget(policy: BotProtection, createdAt: readonly number[], nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || createdAt.length > 128 || createdAt.some(t => !Number.isSafeInteger(t) || t < 1)) return failContinuity("invalid_material");
  const recent = createdAt.filter(t => nowMs - t <= 86400000);
  const clockInvalid = recent.some(t => t > nowMs), cooldown = recent.length > 0 && nowMs - Math.max(...recent) < policy.cooldownMs;
  return { allowed: !clockInvalid && !cooldown && recent.length < policy.maxReplacementsPerDay, recent,
    reason: clockInvalid ? "clock_invalid" : cooldown ? "cooldown" : recent.length >= policy.maxReplacementsPerDay ? "replacement_limit" : null };
}
