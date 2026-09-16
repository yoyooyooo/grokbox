/** Read-only facts from the existing native server activity owner. They are not
 * execution authority, a task registry, a lease, or permission to clear a run. */
export const SERVER_ACTIVITY_SOURCE = "Host.server-agent-activity" as const;
export const ACTIVITY_TIMER_STATES = ["pending", "armed", "settled", "not_required", "failed"] as const;
export const ACTIVITY_MAX_SESSIONS = 512;
export const ACTIVITY_QUERY_LIMIT = 32;
export type ServerActivitySession = {
  agentId: string; sessionId: string; observedAtMs: number;
  serverUpdatedAtMs?: number; serverStaleAfterMs?: number;
  isRunning?: boolean; hasRunningSubagents?: boolean; isComposingMessage?: boolean;
  ttlMs?: number; elapsedMs?: number; remainingMs?: number;
  timer: typeof ACTIVITY_TIMER_STATES[number]; settledAtMs?: number;
};
export type ActivityProjection = {
  state: "observed" | "absent" | "unavailable";
  isRunning?: boolean; isRunningTurn?: boolean; isComposingMessage?: boolean;
  runningSessionIds?: string[]; sessionsTruncated?: boolean;
};
export type ServerActivitySnapshot = {
  version: 1; source: typeof SERVER_ACTIVITY_SOURCE; hostGenerationId: string;
  observedAtMs: number; instrumented: boolean; evictedSessions: number;
  agents: Array<{ agentId: string; projection: ActivityProjection; sessions: ServerActivitySession[]; sessionsTruncated: boolean }>;
};
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined;
}
export function activityId(value: unknown, empty = false): value is string {
  return typeof value === "string" && (empty && value === "" || /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
}
function integer(value: unknown, signed = false): number | undefined {
  // Native protobuf timestamps may be bigint. Never coerce objects or strings.
  const n = typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && (signed || n >= 0) ? n : undefined;
}
export function projectActivitySession(value: unknown): ServerActivitySession | undefined {
  try {
    const agentId = own(value, "agentId"), sessionId = own(value, "sessionId"), observedAtMs = integer(own(value, "observedAtMs"));
    const timer = own(value, "timer");
    if (!activityId(agentId) || !activityId(sessionId, true) || observedAtMs === undefined
      || typeof timer !== "string" || !(ACTIVITY_TIMER_STATES as readonly string[]).includes(timer)) return undefined;
    const result: ServerActivitySession = { agentId, sessionId, observedAtMs, timer: timer as ServerActivitySession["timer"] };
    for (const key of ["isRunning", "hasRunningSubagents", "isComposingMessage"] as const) {
      const v = own(value, key); if (typeof v === "boolean") result[key] = v;
    }
    for (const key of ["serverUpdatedAtMs", "serverStaleAfterMs", "ttlMs", "elapsedMs", "remainingMs", "settledAtMs"] as const) {
      const n = integer(own(value, key), key === "remainingMs"); if (n !== undefined) result[key] = n;
    }
    return result;
  } catch { return undefined; }
}
export function activitySessionFromNative(live: unknown, timing: unknown, now: number): ServerActivitySession | undefined {
  return projectActivitySession({ agentId: own(live, "agentId"), sessionId: own(live, "sessionId") ?? "", observedAtMs: now,
    serverUpdatedAtMs: own(live, "updatedAtMs"), serverStaleAfterMs: own(live, "staleAfterMs"),
    isRunning: own(live, "isRunning"), hasRunningSubagents: own(live, "hasRunningSubagents"), isComposingMessage: own(live, "isComposingMessage"),
    ttlMs: own(timing, "ttlMs"), elapsedMs: own(timing, "elapsedMs"), remainingMs: own(timing, "remainingMs"), timer: "pending" });
}
export function activityProjectionFromNative(value: unknown): ActivityProjection {
  try {
    const live = own(value, "live");
    if (value === null || live === null) return { state: "absent" };
    if (live === undefined) return { state: "unavailable" };
    return projectActivityProjection({ state: "observed", isRunning: own(live, "isRunning"),
      isRunningTurn: own(live, "isRunningTurn"), isComposingMessage: own(live, "isComposingMessage"),
      runningSessionIds: own(live, "runningSessionIds") });
  } catch { return { state: "unavailable" }; }
}
export function projectActivityProjection(value: unknown): ActivityProjection {
  try {
    const state = own(value, "state");
    if (state !== "observed" && state !== "absent") return { state: "unavailable" };
    const result: ActivityProjection = { state };
    if (state === "absent") return result;
    for (const key of ["isRunning", "isRunningTurn", "isComposingMessage"] as const) {
      const v = own(value, key); if (typeof v === "boolean") result[key] = v;
    }
    const ids = own(value, "runningSessionIds");
    if (Array.isArray(ids)) {
      result.runningSessionIds = [];
      for (let i = 0; i < Math.min(ids.length, ACTIVITY_QUERY_LIMIT); i++) {
        const id = own(ids, String(i)); if (activityId(id, true)) result.runningSessionIds.push(id);
      }
      result.sessionsTruncated = ids.length > ACTIVITY_QUERY_LIMIT || own(value, "sessionsTruncated") === true;
    }
    return result;
  } catch { return { state: "unavailable" }; }
}
export function projectServerActivityEvent(value: unknown) {
  try {
    const at = own(value, "at"), event = own(value, "event"), hostGenerationId = own(value, "hostGenerationId");
    const session = projectActivitySession(own(value, "session"));
    if (own(value, "name") !== "host_server_activity_observation" || own(value, "schemaVersion") !== 1
      || typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at))
      || !activityId(hostGenerationId) || !session || own(value, "agentId") !== session.agentId
      || typeof event !== "string" || !["received", "armed", "settled", "not_required", "failed"].includes(event)) return null;
    return { name: "host_server_activity_observation" as const, schemaVersion: 1 as const, at, hostGenerationId,
      agentId: session.agentId, event, session };
  } catch { return null; }
}
export function projectServerActivitySnapshot(value: unknown): ServerActivitySnapshot | undefined {
  try {
    const hostGenerationId = own(value, "hostGenerationId"), observedAtMs = integer(own(value, "observedAtMs"));
    const agents = own(value, "agents"), evictedSessions = integer(own(value, "evictedSessions"));
    if (own(value, "version") !== 1 || own(value, "source") !== SERVER_ACTIVITY_SOURCE || !activityId(hostGenerationId)
      || observedAtMs === undefined || !Array.isArray(agents) || agents.length > ACTIVITY_QUERY_LIMIT || evictedSessions === undefined) return undefined;
    const result: ServerActivitySnapshot = { version: 1, source: SERVER_ACTIVITY_SOURCE, hostGenerationId, observedAtMs,
      instrumented: own(value, "instrumented") === true, evictedSessions, agents: [] };
    for (let index = 0; index < agents.length; index++) {
      const raw = own(agents, String(index)), agentId = own(raw, "agentId"), rows = own(raw, "sessions");
      if (!activityId(agentId) || !Array.isArray(rows)) continue;
      const sessions: ServerActivitySession[] = [];
      for (let i = 0; i < Math.min(rows.length, ACTIVITY_QUERY_LIMIT); i++) {
        const session = projectActivitySession(own(rows, String(i)));
        if (session?.agentId === agentId) sessions.push(session);
      }
      result.agents.push({ agentId, projection: projectActivityProjection(own(raw, "projection")), sessions,
        sessionsTruncated: rows.length > ACTIVITY_QUERY_LIMIT || own(raw, "sessionsTruncated") === true });
    }
    return result;
  } catch { return undefined; }
}
