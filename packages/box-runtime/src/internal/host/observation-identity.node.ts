import { randomUUID } from "node:crypto";

export type ObservationIdentity = {
  version: 1; eventId: string; writerId: string; sequence: number;
  role: "host" | "modeld"; pid: number; observedAt: string; monotonicMs: number;
};
let writerId = randomUUID();
let sequence = 0;
/** Producer-local order, never a cross-process causal clock or execution token. */
export function nextObservationIdentity(role: ObservationIdentity["role"]): ObservationIdentity {
  if (sequence >= 1_000_000_000) { writerId = randomUUID(); sequence = 0; }
  sequence++;
  return { version: 1, eventId: `${writerId}:${sequence}`, writerId, sequence, role, pid: process.pid,
    observedAt: new Date().toISOString(), monotonicMs: Math.max(0, Math.floor(performance.now())) };
}
export function projectObservationIdentity(value: unknown): ObservationIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.writerId !== "string" || !/^[a-f0-9-]{36}$/.test(v.writerId)
    || typeof v.sequence !== "number" || !Number.isSafeInteger(v.sequence) || v.sequence <= 0 || v.sequence > 1_000_000_000
    || v.eventId !== `${v.writerId}:${v.sequence}` || (v.role !== "host" && v.role !== "modeld")
    || typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0
    || typeof v.observedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.observedAt) || !Number.isFinite(Date.parse(v.observedAt))
    || typeof v.monotonicMs !== "number" || !Number.isSafeInteger(v.monotonicMs) || v.monotonicMs < 0) return undefined;
  return { version: 1, eventId: v.eventId as string, writerId: v.writerId, sequence: v.sequence, role: v.role,
    pid: v.pid, observedAt: v.observedAt, monotonicMs: v.monotonicMs };
}
