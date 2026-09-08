import { resolve } from "node:path";
import type { SlicePatch } from "./transform.ts";
import { ROUTE_SESSION_SYMBOL } from "./transform.ts";

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
    find: "      return createCursorInferencePromptSession(inferenceOptions);\n",
    replacement:
      `      const __grokbox_session = createCursorInferencePromptSession(inferenceOptions);\n      const __grokbox_hook = globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")];\n      return typeof __grokbox_hook === "function" ? __grokbox_hook({ originalSession: __grokbox_session, sessionOptions, agentId: sessionOptions?.agentId, onRequestId }) : __grokbox_session;\n`,
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
