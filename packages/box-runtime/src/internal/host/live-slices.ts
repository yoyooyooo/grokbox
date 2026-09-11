import { resolve } from "node:path";
import type { SlicePatch } from "./profile.ts";
import { HOST_ACTIVITY_SYMBOL, HOST_AUX_SYMBOL, HOST_COMPACT_SYMBOL, ROUTE_SESSION_SYMBOL } from "./profile.ts";

export const LIVE_HOST_BUNDLE = "/home/box/sand-host/host-main.cjs";

export function isLiveHostPath(path: string): boolean {
  return resolve(path) === resolve(LIVE_HOST_BUNDLE);
}

/** One explicit call-site purpose; the managed session supplies the completed parent STEP/selection. */
function auxExecutor(purpose: "memory-extraction" | "episode", indent: string): string {
  return `${indent}executor: ((__grokbox_executor) => {\n${indent}  const __grokbox_aux = globalThis[Symbol.for("${HOST_AUX_SYMBOL}")];\n${indent}  return typeof __grokbox_aux === "function"\n${indent}    ? __grokbox_aux({ executor: __grokbox_executor, purpose: "${purpose}", turnId: ctx.get(requestIdKey), ctx }) ?? __grokbox_executor\n${indent}    : __grokbox_executor;\n${indent}})(session.getExecutor()),\n`;
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
  // Separate unique replacements: do not relax find-count or copy the Host memory policy.
  {
    id: "memory-purpose",
    startAnchor: "    const extraction = await extractMemories({\n",
    endAnchor: "      userMessage: exchange.user,\n",
    find: "      executor: session.getExecutor(),\n",
    replacement: auxExecutor("memory-extraction", "      "),
  },
  {
    id: "episode-purpose",
    startAnchor: "      const narrative = await summarizeEpisode({\n",
    endAnchor: "        turns: pending\n",
    find: "        executor: session.getExecutor(),\n",
    replacement: auxExecutor("episode", "        "),
  },
  {
    id: "harness-blank",
    startAnchor:
      "    ...fileProfile?.namedBy === void 0 ? {} : { namedBy: fileProfile.namedBy },\n    ...readSandProfileHarness(profilePath) === \"temporal\" ? { harness: \"temporal\" } : {},\n",
    endAnchor: "async function buildSummary(args)",
    find: "    ...readSandProfileHarness(profilePath) === \"temporal\" ? { harness: \"temporal\" } : {},\n    isGroup: false,\n",
    replacement:
      "    harness: readSandProfileHarness(profilePath) === \"temporal\" ? \"temporal\" : \"box\",\n    isGroup: false,\n",
  },
  {
    id: "harness-summary",
    startAnchor: "    isGroup,\n    memberIds,\n",
    endAnchor: "async function agentHasDurableFootprint(agentDir, agentHasMemory)",
    find: "    ...readSandProfileHarness(profilePath) === \"temporal\" ? { harness: \"temporal\" } : {}\n",
    replacement:
      "    harness: readSandProfileHarness(profilePath) === \"temporal\" ? \"temporal\" : \"box\"\n",
  },
];
