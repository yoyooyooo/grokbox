import type { SlicePatch } from "./profile.ts";
import { HOST_CONTEXT_CONTROL_SYMBOL } from "./context-control.node.ts";
const control = `globalThis[Symbol.for("${HOST_CONTEXT_CONTROL_SYMBOL}")]`;

/** Narrow native hooks: reuse the existing runner and summarize-action owner.
 * The WeakMap-backed operation flag cannot be supplied through RPC JSON. */
export const CONTEXT_MAINTENANCE_SLICES: readonly SlicePatch[] = [
  {
    id: "context-manual-shell-owner",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: "  return {\n    run,\n    steer,\n    interrupt,\n    interruptAll,\n",
    replacement: `  return {
    run: ${control}?.wrapRun(host, run, () => cancelActiveRun !== null || pausingForUpgrade, reason => interrupt(reason)) ?? run,
    steer,
    interrupt,
    interruptAll,
`,
  },
  {
    id: "context-manual-trusted-options",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: "      const resumeTurn = options2.resumeTurn === true;\n",
    replacement: `      const __grokbox_context_op = ${control}?.manualOptions(host, options2);
      const resumeTurn = options2.resumeTurn === true || __grokbox_context_op !== undefined;
`,
  },
  {
    id: "context-manual-native-action",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: "          action: RESUME_TURN_ACTION,\n          automationStatusReminder: null,\n",
    replacement: `          action: __grokbox_context_op === undefined ? RESUME_TURN_ACTION : new ConversationAction({ action: { case: "summarizeAction", value: new SummarizeAction() } }),
          automationStatusReminder: null,
`,
  },
  {
    id: "context-manual-no-business-settlement",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: "        if (!aborted2 && !pausedForUpgrade) {\n          await settle.settleCompletedTurn({\n",
    replacement: "        if (!aborted2 && !pausedForUpgrade && __grokbox_context_op === undefined) {\n          await settle.settleCompletedTurn({\n",
  },
  {
    id: "context-manual-summary-owner",
    startAnchor: "var SummarizeActionHandler = class {",
    endAnchor: "var ResumeActionHandler = class extends AbstractUserMessageActionHandler {",
    find: "  async handle(ctx, _action, rootPromptExecutor, stateHandler, _mcpTools, onStateUpdate) {\n    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;\n",
    replacement: `  async handle(ctx, _action, rootPromptExecutor, stateHandler, _mcpTools, onStateUpdate) {
    const __grokbox_context_handled = ${control}?.manualAction({
      agentId: this.config.conversationGroupId, turnId: ctx.get(requestIdKey),
      capture: async () => {
        const requestContext = await getRequestContext(ctx, void 0, this.resourceAccessor, buildRequestContextOptions(this.config));
        const toolSet = this.config.toolsGenerator({ resourceAccessor: this.resourceAccessor, stateHandler,
          agentSessionId: this.config.agentSessionId, mcpTools: _mcpTools,
          repositoryInfos: requestContext.repositoryInfo, blobStore: stateHandler.getBlobStore(),
          mode: stateHandler.mode ?? AgentMode.AGENT, loggingContext: ctx, requestContext,
          fileOperationLockManager: new FileOperationLockManager(), smartModeClassifierMode: this.config.smartModeClassifierMode,
          smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode, autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion });
        return { agentId: this.config.conversationGroupId, turnId: ctx.get(requestIdKey),
          orchestrator: this.orchestrator, ctx, stateHandler, rootPromptExecutor, interactionListener: this.interactionListener,
          config: this.config, requestContext, resourceAccessor: this.resourceAccessor,
          normalizeContext: messages => fromRedactedCoreMessages(messages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          contextFixedMessages: () => { const fixed = prepareMessagesForCompaction(rootPromptExecutor.getMessages()); return [fixed.systemMessage, fixed.userInfoMessage].filter(Boolean); },
          contextTools: () => toAgentTools(toolSet.getStaticTools(), toolSet.getDescriptionProps()),
          contextActivity: async (active, failed) => this.interactionListener.sendUpdate(ctx, active ? RedactedUpdates.summaryStarted(PrivacyMode.UNSPECIFIED) : toRedactedInteractionUpdate(Updates.summaryCompleted(void 0, failed ? true : void 0), PrivacyMode.UNSPECIFIED)),
          contextCheckpoint: async () => { if (typeof onStateUpdate !== "function") throw new Error("context_checkpoint_unavailable"); await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx)); }
        };
      }
    });
    if (__grokbox_context_handled !== undefined) {
      await __grokbox_context_handled;
      return await stateHandler.computeNewStructure(ctx);
    }
    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;
`,
  },
  {
    id: "context-control-rpc-schema",
    startAnchor: "    getHostStatus: rpcMethod().args(hostStatusArgs),",
    endAnchor: "    setBoxMigrating: rpcMethod().args({ migrating: rpcBoolean() }),",
    find: "    getHostStatus: rpcMethod().args(hostStatusArgs),\n",
    replacement: "    getHostStatus: rpcMethod().args(hostStatusArgs),\n    grokboxContextControl: rpcMethod().args(rpcObject({ action: rpcString(), agentId: rpcString(), sessionId: rpcOptional(rpcString()), operationId: rpcOptional(rpcString()), confirm: rpcOptional(rpcBoolean()) })),\n",
  },
  {
    id: "context-control-rpc-api",
    startAnchor: "    setBoxMigrating: async (args) => {",
    endAnchor: "    setHttpProxyName: (args) => deps.extensions.api(\"telemetry\").setHttpProxyName(args.name),",
    find: "    setBoxMigrating: async (args) => {",
    replacement: `    grokboxContextControl: async args => {
      const capability = ${control};
      if (typeof capability?.call !== "function") return { ok: false, error: { code: "capability_unqualified" } };
      return await capability.call(args, () => api.getHostStatus({ grokboxOwnershipAgentIds: [args.agentId] }));
    },
    setBoxMigrating: async (args) => {`,
  },
];
