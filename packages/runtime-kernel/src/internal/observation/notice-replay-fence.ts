import { NOTIFICATION_DELIVERY_POLICY } from "./notification-contract.ts";
import { OBSERVATION_RETENTION } from "./retention-policy.ts";

export type NoticeReplaySnapshot = { version: 1; floorMs: number; highWaterMs: number;
  entries: Array<{ occurrenceIdentity: string; expiresAtMs: number; workId: string; attemptId: string | null; rejected: boolean }> };
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export function validateNoticeReplaySnapshot(value: NoticeReplaySnapshot, maxEntries: number): NoticeReplaySnapshot {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.floorMs) || value.floorMs < 1
    || !Number.isSafeInteger(value.highWaterMs) || value.highWaterMs < value.floorMs
    || !Array.isArray(value.entries) || value.entries.length > maxEntries
    || new Set(value.entries.map(e => e?.occurrenceIdentity)).size !== value.entries.length
    || value.entries.some(e => !e || !/^[a-f0-9]{64}$/.test(e.occurrenceIdentity) || !uuid(e.workId)
      || e.attemptId !== null && !uuid(e.attemptId) || typeof e.rejected !== "boolean" || e.rejected && e.attemptId === null
      || !Number.isSafeInteger(e.expiresAtMs) || e.expiresAtMs <= value.highWaterMs)) throw new Error("invalid_notice_replay_snapshot");
  return structuredClone(value);
}

/** Extra fence independent of a restorable observation database. A durable
 * snapshot must be published by the private binding owner before transport.
 * Absence keeps the conservative worker-start floor. The snapshot is evidence
 * against replay, never authority to send or a receipt of actual delivery. */
export function createNoticeReplayFence(startedAtMs: number, maxEntries: number = NOTIFICATION_DELIVERY_POLICY.maxAttempts,
  snapshot?: NoticeReplaySnapshot) {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || maxEntries > NOTIFICATION_DELIVERY_POLICY.maxAttempts) throw new Error("invalid_notice_replay_fence");
  const restored = snapshot ? validateNoticeReplaySnapshot(snapshot, maxEntries) : undefined;
  const floorMs = restored?.floorMs ?? startedAtMs;
  const attempts = new Map<string, { expiresAtMs: number; workId: string; attemptId: string | null; rejected: boolean }>(
    restored?.entries.map(({ occurrenceIdentity, ...entry }) => [occurrenceIdentity, entry]));
  let highWaterMs = restored?.highWaterMs ?? startedAtMs;
  const advance = (nowMs: number): boolean => {
    if (!Number.isSafeInteger(nowMs) || nowMs < highWaterMs) return false;
    highWaterMs = nowMs;
    for (const [id, entry] of attempts) if (entry.expiresAtMs <= highWaterMs) attempts.delete(id);
    return true;
  };
  return {
    startedAtMs: floorMs,
    check(nowMs: number) { return advance(nowMs) ? null : "replay_clock_reversed" as const; },
    claim(input: { workId: string; occurrenceIdentity: string; createdAtMs: number; occurrenceAtMs: number; expiresAtMs: number; nowMs: number;
      attemptId?: string; retryOf?: string }) {
      if (!advance(input.nowMs)) return "replay_clock_reversed" as const;
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.workId)
        || !/^[a-f0-9]{64}$/.test(input.occurrenceIdentity) || ![input.createdAtMs, input.occurrenceAtMs, input.expiresAtMs].every(n => Number.isSafeInteger(n) && n > 0)) return "replay_identity_unavailable" as const;
      if (input.createdAtMs <= floorMs || input.occurrenceAtMs <= floorMs) return "work_precedes_worker" as const;
      if (input.createdAtMs > highWaterMs || input.occurrenceAtMs > highWaterMs || input.expiresAtMs <= highWaterMs
        || input.occurrenceAtMs + OBSERVATION_RETENTION.notificationTtlMs <= highWaterMs) return "replay_window_unavailable" as const;
      const previous = attempts.get(input.occurrenceIdentity);
      if (previous && !(previous.rejected && previous.workId === input.workId && previous.attemptId !== null
        && input.retryOf === previous.attemptId && input.attemptId !== undefined && input.attemptId !== previous.attemptId))
        return "prior_lifetime_attempt" as const;
      if (!previous && attempts.size >= maxEntries) return "replay_fence_capacity" as const;
      attempts.set(input.occurrenceIdentity, { expiresAtMs: Math.max(input.expiresAtMs, input.occurrenceAtMs + OBSERVATION_RETENTION.notificationTtlMs),
        workId: input.workId, attemptId: input.attemptId ?? null, rejected: false });
      return null;
    },
    /** Called only after the original outbox committed a definite native
     * rejection. Retain the last attempt identity: a restored older rejection
     * must not acquire another retry after a newer attempt became unknown. */
    definitelyRejected(input: { occurrenceIdentity: string; workId: string; attemptId: string; nowMs: number }) {
      if (!advance(input.nowMs)) return false;
      const entry = attempts.get(input.occurrenceIdentity);
      if (!entry || entry.workId !== input.workId || entry.attemptId !== input.attemptId) return false;
      entry.rejected = true;
      return true;
    },
    priorAttempt(occurrenceIdentity: string, nowMs: number, retry?: { workId: string; attemptId: string }) {
      if (!advance(nowMs)) return "replay_clock_reversed" as const;
      const entry = attempts.get(occurrenceIdentity);
      if (entry && retry && entry.rejected && entry.workId === retry.workId && entry.attemptId === retry.attemptId) return null;
      return entry ? "prior_lifetime_attempt" as const : null;
    },
    snapshot(): NoticeReplaySnapshot { return { version: 1, floorMs, highWaterMs,
      entries: [...attempts].map(([occurrenceIdentity, entry]) => ({ occurrenceIdentity, ...entry })) }; },
    status() { return { policy: restored ? "binding-durable-attempts-v1" as const : "worker-start-and-live-attempts-v1" as const,
      startedAtMs: floorMs, highWaterMs, guardedWork: attempts.size, maxEntries,
      restoresExistingWork: !!restored, scope: "automatic_notifications_only" as const }; },
  };
}
export type NoticeReplayFence = ReturnType<typeof createNoticeReplayFence>;
