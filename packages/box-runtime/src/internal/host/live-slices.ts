import { resolve } from "node:path";
import type { SlicePatch } from "./profile.ts";
import { HOST_ACTIVITY_SYMBOL, HOST_COMPACT_SYMBOL, ROUTE_SESSION_SYMBOL } from "./profile.ts";

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
    // Wrap after the official session exists so no-STEP compact/memory can use it.
    // Undefined still declines to the official session. STEP streams stay managed.
    find: "      return createCursorInferencePromptSession(inferenceOptions);\n",
    replacement:
      `      const __grokbox_original = createCursorInferencePromptSession(inferenceOptions);\n      const __grokbox_hook = globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")];\n      if (typeof __grokbox_hook === "function") {\n        const __grokbox_session = __grokbox_hook({ originalSession: __grokbox_original, sessionOptions, agentId: sessionOptions?.agentId, onRequestId });\n        if (__grokbox_session !== undefined) return __grokbox_session;\n      }\n      return __grokbox_original;\n`,
  },
  {
    id: "agent-id",
    startAnchor: "const mainSessionOptions = {",
    endAnchor: "async () => host.inference.createSession(emitRequestId, mainSessionOptions)",
    find: "          modelId: host.subagentModelId,\n",
    replacement:
      "          agentId: host.getConversationId(),\n          invocationId: inferenceRequestId,\n          modelId: host.subagentModelId,\n",
  },
  {
    id: "compact-register",
    startAnchor: "let stepClosed = false;",
    endAnchor: "        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([",
    find: "      let response;\n      let extendedUsage;\n      let usage;\n      let finalInvocationId;\n      try {\n",
    replacement:
      `      const __grokbox_compact = globalThis[Symbol.for("${HOST_COMPACT_SYMBOL}")];\n      if (typeof __grokbox_compact === "function") {\n        const __grokbox_compact_slot = __grokbox_compact({\n          orchestrator: this.orchestrator,\n          ctx,\n          stateHandler,\n          rootPromptExecutor,\n          interactionListener: this.interactionListener,\n          config: this.config,\n          requestContext,\n          invocationId,\n          turnId: ctx.get(requestIdKey),\n          agentId: this.config.conversationGroupId,\n          resourceAccessor: this.resourceAccessor,\n          stepClosed: () => stepClosed\n        });\n        if (__grokbox_compact_slot != null) __addDisposableResource23(env_2, __grokbox_compact_slot, false);\n      }\n      let response;\n      let extendedUsage;\n      let usage;\n      let finalInvocationId;\n      try {\n`,
  },
  {
    id: "activity-bridge",
    startAnchor: "new ForwardingInteractionListener(",
    endAnchor: "            onToolCall: (event, callId, toolCall) => {",
    find: "          (update) => {\n            streamWatchdog.noteUpdate(update);\n            host.emitUpdate(update, updateObservers);\n          },\n",
    replacement:
      `          ((__grokbox_activity_emit) => {\n            globalThis[Symbol.for("${HOST_ACTIVITY_SYMBOL}")] = __grokbox_activity_emit;\n            return __grokbox_activity_emit;\n          })((update) => {\n            streamWatchdog.noteUpdate(update);\n            host.emitUpdate(update, updateObservers);\n          }),\n`,
  },
];
