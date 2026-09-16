/** Synthetic timer-owner seam shared by full-profile and observation tests.
 * No private Host implementation or live dependency. */
export const SERVER_ACTIVITY_SHAPED_HOST = `
function createSyntheticServerActivity() {
  const sessions = new Map();
  const timers = [];
  const publish = () => {};
  const settleStale = (agentId, sessionId, session) => {
    if (sessions.get(sessionId) !== session) return;
    session.staleTimer = null;
    session.live = { isRunning: false };
    publish(agentId);
  };
  const armStale = (agentId, sessionId, session, staleInMs) => {
    if (staleInMs === 123) throw new Error("native-failure");
    if (!session.live.isRunning) return;
    if (staleInMs <= 0) { settleStale(agentId, sessionId, session); return; }
    session.staleTimer = {};
    timers.push(() => settleStale(agentId, sessionId, session));
  };
  const applyLive = (live) => {
    const sessionId = live.sessionId;
    const session = { live: { isRunning: live.isRunning || live.hasRunningSubagents }, staleTimer: null };
    sessions.set(sessionId, session);
    const ttlMs = live.ttl;
    const elapsedMs3 = 0;
    armStale(live.agentId, sessionId, session, ttlMs - elapsedMs3);
    return session;
  };
  const applyClient = (client) => {};
  return { applyLive, timers, sessions };
}
`;
