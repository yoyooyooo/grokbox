import {
  ACTIVITY_MAX_SESSIONS, ACTIVITY_QUERY_LIMIT, SERVER_ACTIVITY_SOURCE, activityId,
  activitySessionFromNative, activityProjectionFromNative, projectActivitySession,
  projectServerActivitySnapshot, type ServerActivitySession,
} from "@grokbox/runtime-kernel/contract";

export const HOST_SERVER_ACTIVITY_SYMBOL = "grokbox.box-runtime.server-activity-observation.v1";

/** A bounded witness of native activity, not a second scheduler or writer.
 * Queries compare the last received frame with the native owner's current view. */
export function createServerActivityObserver(options: {
  generation: string; instrumented: boolean; now?: () => number;
  emit?: (event: Record<string, unknown>) => void;
}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, ServerActivitySession>();
  let evictedSessions = 0;
  const key = (agentId: string, sessionId: string) => JSON.stringify([agentId, sessionId]);
  function emit(event: "received" | "armed" | "settled" | "not_required" | "failed", session: ServerActivitySession) {
    try { options.emit?.({ name: "host_server_activity_observation", schemaVersion: 1, at: new Date(now()).toISOString(),
      hostGenerationId: options.generation, agentId: session.agentId, event, session: projectActivitySession(session) }); } catch { /* observation is nonfatal */ }
  }
  function update(agentId: unknown, sessionId: unknown, timer: ServerActivitySession["timer"]) {
    if (!activityId(agentId) || !activityId(sessionId, true)) return;
    const row = sessions.get(key(agentId, sessionId));
    if (!row) return;
    // Immediate native expiry occurs inside armStale; the return from arm must
    // not relabel that settled observation as an idle/no-timer receipt.
    if (timer === "not_required" && row.timer === "settled") return;
    row.timer = timer;
    if (timer === "settled") row.settledAtMs = now();
    if (timer !== "pending") emit(timer, row);
  }
  return {
    received(live: unknown, timing: unknown) {
      const row = activitySessionFromNative(live, timing, now());
      if (!row) return;
      const id = key(row.agentId, row.sessionId);
      sessions.delete(id);
      if (sessions.size >= ACTIVITY_MAX_SESSIONS) { sessions.delete(sessions.keys().next().value!); evictedSessions++; }
      sessions.set(id, row);
      emit("received", row);
    },
    armed(agentId: unknown, sessionId: unknown, active: unknown) { update(agentId, sessionId, active === true ? "armed" : "not_required"); },
    failed(agentId: unknown, sessionId: unknown) { update(agentId, sessionId, "failed"); },
    settled(agentId: unknown, sessionId: unknown) { update(agentId, sessionId, "settled"); },
    snapshot(agentIds: unknown, readOverlay: (agentId: string) => unknown) {
      if (!Array.isArray(agentIds) || agentIds.length > ACTIVITY_QUERY_LIMIT || agentIds.some(id => !activityId(id))) return undefined;
      return projectServerActivitySnapshot({ version: 1, source: SERVER_ACTIVITY_SOURCE, hostGenerationId: options.generation,
        observedAtMs: now(), instrumented: options.instrumented, evictedSessions,
        agents: agentIds.map(agentId => {
          let projection: unknown = { state: "unavailable" };
          try {
            projection = activityProjectionFromNative(readOverlay(agentId));
          } catch { /* no usable native projection */ }
          const rows = [...sessions.values()].filter(row => row.agentId === agentId);
          return { agentId, projection, sessions: rows.slice(0, ACTIVITY_QUERY_LIMIT), sessionsTruncated: rows.length > ACTIVITY_QUERY_LIMIT };
        }),
      });
    },
  };
}
