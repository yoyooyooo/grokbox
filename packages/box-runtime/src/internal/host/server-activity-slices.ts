import type { SlicePatch } from "./profile.ts";
import { HOST_SERVER_ACTIVITY_SYMBOL } from "./server-activity-observation.ts";

/** Observe the existing timer owner. No new Watch RPC, expiry policy, task stop,
 * overlay writer, or replacement of the upstream scheduler. */
export const SERVER_ACTIVITY_OBSERVATION_SLICES: readonly SlicePatch[] = [
  {
    id: "server-activity-live-observation",
    startAnchor: "  const applyLive = (live) => {",
    endAnchor: "  const applyClient = (client) => {",
    find: "    armStale(live.agentId, sessionId, session, ttlMs - elapsedMs3);\n",
    replacement: `    const __grokbox_activity = globalThis[Symbol.for("${HOST_SERVER_ACTIVITY_SYMBOL}")];
    try { __grokbox_activity?.received(live, { ttlMs, elapsedMs: elapsedMs3, remainingMs: ttlMs - elapsedMs3 }); } catch {}
    try {
      armStale(live.agentId, sessionId, session, ttlMs - elapsedMs3);
    } catch (__grokbox_native_error) {
      try { __grokbox_activity?.failed(live.agentId, sessionId); } catch {}
      throw __grokbox_native_error;
    }
    try { __grokbox_activity?.armed(live.agentId, sessionId, session.staleTimer != null); } catch {}
`,
  },
  {
    id: "server-activity-expiry-observation",
    startAnchor: "  const settleStale = (agentId, sessionId, session) => {",
    endAnchor: "  const armStale = (agentId, sessionId, session, staleInMs) => {",
    find: "    publish(agentId);\n",
    replacement: `    try { globalThis[Symbol.for("${HOST_SERVER_ACTIVITY_SYMBOL}")]?.settled(agentId, sessionId); } catch {}
    publish(agentId);
`,
  },
];
