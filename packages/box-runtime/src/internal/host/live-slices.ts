import { resolve } from "node:path";
import { OWNERSHIP_READ_SLICES } from "./ownership-slices.ts";
import { ALERT_OBSERVATION_SLICES } from "./alert-slices.ts";
import type { SlicePatch } from "./profile.ts";
import { HOST_ACTIVITY_SYMBOL, HOST_AUX_SYMBOL, HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, HOST_MANAGED_FAILURE_SYMBOL, HOST_MANAGED_STEP_FAILURE_SYMBOL, ROUTE_SESSION_SYMBOL } from "./profile.ts";
import { HOST_PROFILE_TITLE_SYMBOL } from "./title-marker.ts";
import { HOST_RUN_OBSERVATION_SYMBOL } from "./run-observation.ts";

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
    // Construct the native session first for exact official passthrough when
    // unassigned. Managed aux calls require the separately qualified purpose.
    // Undefined still declines to the official session. STEP streams stay managed.
    find: "      return createCursorInferencePromptSession(inferenceOptions);\n",
    replacement:
      `      const __grokbox_original = createCursorInferencePromptSession(inferenceOptions);\n      const __grokbox_hook = globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")];\n      if (typeof __grokbox_hook === "function") {\n        const __grokbox_session = __grokbox_hook({ originalSession: __grokbox_original, sessionOptions, agentId: sessionOptions?.agentId, onRequestId });\n        if (__grokbox_session !== undefined) return __grokbox_session;\n      }\n      return __grokbox_original;\n`,
  },
  {
    id: "agent-id",
    startAnchor: "const mainSessionOptions = {",
    endAnchor: "async () => host.inference.createSession(emitRequestId, mainSessionOptions)",
    // Insert identity at the options boundary, preserving the Host's modelId /
    // executorProfile choice and all native fields. Do not replace that choice.
    // clientNonce is the same runTurn options2 field CP26 writes to lastTurnSettlement.
    // Live Host loads this only after reviewed profile write + runtime re-adopt --confirm.
    find: "const mainSessionOptions = {\n",
    replacement:
      "const mainSessionOptions = {\n          agentId: host.getConversationId(),\n          invocationId: inferenceRequestId,\n          clientNonce: options2.clientNonce,\n",
  },
  {
    id: "compact-register",
    // Actual STEP/root/ctx already exist here, but the first provider request has not started.
    // Own the full native env_2 lifetime; do not read the later stepClosed binding in its TDZ.
    startAnchor: "        result = rootPromptExecutor.executeToolStream(\n",
    endAnchor: "let stepClosed = false;",
    find: "        result = rootPromptExecutor.executeToolStream(\n",
    replacement:
      `        const __grokbox_compact = globalThis[Symbol.for("${HOST_COMPACT_SYMBOL}")];\n        if (typeof __grokbox_compact === "function") {\n          let __grokbox_compact_active = true;\n          const __grokbox_compact_lease = __grokbox_compact({\n            orchestrator: this.orchestrator, ctx, stateHandler, rootPromptExecutor,\n            interactionListener: this.interactionListener, config: this.config, requestContext,\n            invocationId, turnId: ctx.get(requestIdKey), agentId: this.config.conversationGroupId,\n            resourceAccessor: this.resourceAccessor, stepClosed: () => !__grokbox_compact_active\n          });\n          if (__grokbox_compact_lease != null) {\n            const __grokbox_compact_slot = { [Symbol.dispose]() {\n              __grokbox_compact_active = false;\n              __grokbox_compact_lease[Symbol.dispose]();\n            } };\n            __addDisposableResource23(env_2, __grokbox_compact_slot, false);\n          }\n        }\n        result = rootPromptExecutor.executeToolStream(\n`,
  },
  {
    id: "compact-background-start",
    startAnchor: "        await startBackgroundSummary();\n",
    endAnchor: "let stepClosed = false;",
    find: "        await startBackgroundSummary();\n",
    replacement:
      `        const __grokbox_managed = globalThis[Symbol.for("${HOST_MANAGED_STEP_SYMBOL}")];\n        if (typeof __grokbox_managed !== "function" || !__grokbox_managed(rootPromptExecutor)) {\n          await startBackgroundSummary();\n        }\n`,
  },
  {
    id: "compact-background-response",
    startAnchor: "      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {\n",
    endAnchor: "        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([",
    find: "      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {\n",
    replacement:
      `      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {\n        const __grokbox_managed = globalThis[Symbol.for("${HOST_MANAGED_STEP_SYMBOL}")];\n        if (typeof __grokbox_managed === "function" && __grokbox_managed(rootPromptExecutor)) return;\n`,
  },
  {
    id: "managed-retry-gate",
    startAnchor: "  if (!(classifyError2(error41) instanceof RetriableError)) return false;\n",
    endAnchor: "  if (classified instanceof NonRetriableError || classified instanceof ActionRequiredError) {",
    find: "  if (!(classifyError2(error41) instanceof RetriableError)) return false;\n",
    replacement:
      `  const __grokbox_failed = globalThis[Symbol.for("${HOST_MANAGED_FAILURE_SYMBOL}")];\n  if (typeof __grokbox_failed === "function" && __grokbox_failed(error41)) return false;\n  if (!(classifyError2(error41) instanceof RetriableError)) return false;\n`,
  },
  {
    id: "managed-turn-retry-gate",
    // The final TURN policy also consults automation callbacks. Protect that
    // owner, not only isRetryableProviderError's narrower classification path.
    startAnchor: "function shouldRetryTurnAttempt(input) {\n",
    endAnchor: "function computeBackoffDelayMs(params) {",
    find: "function shouldRetryTurnAttempt(input) {\n",
    replacement:
      `function shouldRetryTurnAttempt(input) {\n  const __grokbox_failed = globalThis[Symbol.for("${HOST_MANAGED_FAILURE_SYMBOL}")];\n  if (typeof __grokbox_failed === "function" && __grokbox_failed(input.error)) return false;\n`,
  },
  {
    id: "managed-step-error-scope",
    startAnchor: "  async runStep(parentCtx, turn,",
    endAnchor: "  async runWithMaxTokensRetry(",
    find: "    } catch (e_2) {\n      env_2.error = e_2;\n",
    replacement: `    } catch (e_2) {\n      const __grokbox_step_failure = globalThis[Symbol.for("${HOST_MANAGED_STEP_FAILURE_SYMBOL}")];\n      if (typeof __grokbox_step_failure === "function") {\n        try { __grokbox_step_failure(rootPromptExecutor, e_2); } catch {}\n      }\n      env_2.error = e_2;\n`,
  },
  {
    id: "managed-output-retry-gate",
    startAnchor: "  async runWithMaxTokensRetry(",
    endAnchor: "  async runWithSummarizationRetry(",
    find: "        } catch (error41) {\n          if (error41 instanceof OutputTokensLimitExceededError) {",
    replacement: `        } catch (error41) {\n          const __grokbox_failed = globalThis[Symbol.for("${HOST_MANAGED_FAILURE_SYMBOL}")];\n          if (typeof __grokbox_failed === "function" && __grokbox_failed(error41)) throw error41;\n          if (error41 instanceof OutputTokensLimitExceededError) {`,
  },
  {
    id: "managed-summary-retry-gate",
    startAnchor: "  async runWithSummarizationRetry(",
    endAnchor: "  async runTurnLoop(",
    find: "        } catch (error41) {\n          const isProactiveSummarizationThresholdError = error41 instanceof ProactiveSummarizationThresholdError;",
    replacement: `        } catch (error41) {\n          const __grokbox_failed = globalThis[Symbol.for("${HOST_MANAGED_FAILURE_SYMBOL}")];\n          if (typeof __grokbox_failed === "function" && __grokbox_failed(error41)) throw error41;\n          const isProactiveSummarizationThresholdError = error41 instanceof ProactiveSummarizationThresholdError;`,
  },
  {
    id: "activity-bridge",
    startAnchor: "new ForwardingInteractionListener(",
    endAnchor: "            onToolCall: (event, callId, toolCall) => {",
    find: "          (update) => {\n            streamWatchdog.noteUpdate(update);\n            host.emitUpdate(update, updateObservers);\n          },\n",
    // Qualify the native run-owned callback without replacing it with a global
    // last-writer sink. A first canonical event is not synthetic thinking.
    replacement:
      "          // grokbox: preserve this native run's activity/watchdog owner.\n          (update) => {\n            streamWatchdog.noteUpdate(update);\n            host.emitUpdate(update, updateObservers);\n          },\n",
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
      "    harness: readSandProfileHarness(profilePath) ?? undefined,\n    isGroup: false,\n",
  },
  {
    id: "profile-title-marker",
    startAnchor: "writeAgentProfileFile(agentId, profile) {",
    endAnchor: "async withAgentDb(agentId, fn) {",
    find: "    const current = readSandProfileFile(path31);\n    const trimmedName = profile.name.trim();\n",
    replacement:
      `    const current = readSandProfileFile(path31);\n    const __grokbox_title = globalThis[Symbol.for("${HOST_PROFILE_TITLE_SYMBOL}")];\n    if (typeof __grokbox_title === "function") {\n      const __grokbox_next = __grokbox_title({ agentId, profile, localHarness: current?.harness });\n      if (__grokbox_next != null && typeof __grokbox_next.title === "string") profile = { ...profile, title: __grokbox_next.title };\n    }\n    const trimmedName = profile.name.trim();\n`,
  },
  {
    id: "harness-summary",
    startAnchor: "    isGroup,\n    memberIds,\n",
    endAnchor: "async function agentHasDurableFootprint(agentDir, agentHasMemory)",
    find: "    ...readSandProfileHarness(profilePath) === \"temporal\" ? { harness: \"temporal\" } : {}\n",
    replacement:
      "    harness: readSandProfileHarness(profilePath) ?? undefined\n",
  },
  {
    id: "run-queue-observation",
    startAnchor: "  enqueueExclusiveRun(agentId, task, options2) {\n",
    endAnchor: "return scheduler.enqueue(agentId, task, options2);",
    find: "  enqueueExclusiveRun(agentId, task, options2) {\n",
    replacement: `  enqueueExclusiveRun(agentId, task, options2) {\n    const __grokbox_run = globalThis[Symbol.for("${HOST_RUN_OBSERVATION_SYMBOL}")];\n    if (__grokbox_run) { try { const observed = __grokbox_run.queue(agentId, task, options2); task = observed.task; options2 = observed.options; } catch {} }\n`,
  },
  {
    id: "group-member-observation",
    startAnchor: "  async runLocalRoomMemberTurn(args) {\n",
    endAnchor: "  async runTemporalGroupMemberTurn(",
    find: "  async runLocalRoomMemberTurn(args) {\n",
    replacement: `  async runLocalRoomMemberTurn(args) {\n    const __grokbox_run = globalThis[Symbol.for("${HOST_RUN_OBSERVATION_SYMBOL}")];\n    if (__grokbox_run) { const observed = __grokbox_run.group(this, args); if (observed !== undefined) return observed; }\n`,
  },
  {
    id: "group-buffer-observation",
    startAnchor: "  async runLocalRoomMemberTurn(args) {\n",
    endAnchor: "  async runTemporalGroupMemberTurn(",
    find: "          sent.push(update.message.content);\n",
    replacement: `          sent.push(update.message.content);\n          try { globalThis[Symbol.for("${HOST_RUN_OBSERVATION_SYMBOL}")]?.buffered(); } catch {}\n`,
  },
  ...ALERT_OBSERVATION_SLICES,
  ...OWNERSHIP_READ_SLICES,
];
