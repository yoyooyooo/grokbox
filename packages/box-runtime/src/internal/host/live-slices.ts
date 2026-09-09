import { resolve } from "node:path";
import type { SlicePatch } from "./profile.ts";
import { ROUTE_SESSION_SYMBOL } from "./profile.ts";

export const LIVE_HOST_BUNDLE = "/home/box/sand-host/host-main.cjs";

export function isLiveHostPath(path: string): boolean {
  return resolve(path) === resolve(LIVE_HOST_BUNDLE);
}

/** Unique anchors observed on current Grok Box Host bundles. SHA is computed at runtime. */
export const LIVE_SLICE_PATCHES: readonly SlicePatch[] = [
  {
    id: "create-session",
    startAnchor: "createSession(onRequestId, sessionOptions) {",
    endAnchor: "    },\n    recordPostTurnLabeling(args) {",
    // Select the managed backend before *any* official model resolution/client construction.
    // Undefined declines the interception; the unchanged Host body then creates its own session.
    find: "createSession(onRequestId, sessionOptions) {\n",
    replacement:
      `createSession(onRequestId, sessionOptions) {\n      const __grokbox_hook = globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")];\n      if (typeof __grokbox_hook === "function") {\n        const __grokbox_session = __grokbox_hook({ sessionOptions, agentId: sessionOptions?.agentId, onRequestId });\n        if (__grokbox_session !== undefined) return __grokbox_session;\n      }\n`,
  },
  {
    id: "agent-id",
    startAnchor: "const mainSessionOptions = {",
    endAnchor: "async () => host.inference.createSession(emitRequestId, mainSessionOptions)",
    find: "          modelId: host.subagentModelId,\n",
    replacement:
      "          agentId: host.getConversationId(),\n          invocationId: inferenceRequestId,\n          modelId: host.subagentModelId,\n",
  },
];
