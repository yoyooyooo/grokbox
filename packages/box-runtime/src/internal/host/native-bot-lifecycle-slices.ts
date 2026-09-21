import type { SlicePatch } from "./profile.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "./native-current-state-owner.ts";
const owner = `globalThis[Symbol.for("${NATIVE_CURRENT_STATE_SYMBOL}")]`;

export const NATIVE_BOT_LIFECYCLE_SLICES: readonly SlicePatch[] = [
  {
    id: "continuity-native-startup-input",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: '      if (!actionOnly && trimmedPrompt.length === 0',
    replacement: `      const __grokbox_startup = ${owner}?.consumeStartup(host.getConversationId(), options2.grokboxStartupTicket) === true;
      if (!actionOnly && !__grokbox_startup && trimmedPrompt.length === 0`,
  },
  {
    id: "continuity-native-startup-action",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: '        } = actionOnly ? {\n',
    replacement: `        } = __grokbox_startup ? {
          action: new ConversationAction({ action: { case: "userMessageAction", value: new UserMessageAction({
            userMessage: new UserMessage({ text: "", isSimulatedMsg: true,
              messageId: ${owner}.startupMessageId(host.getConversationId()) }),
            sendToInteractionListener: false
          }) } }),
          automationStatusReminder: null, automationStatusCompactionEpoch: 0,
          prependedUserMessageDedupeFloorMessageId: void 0
        } : actionOnly ? {
`,
  },
  {
    id: "continuity-native-startup-no-user-prompt",
    startAnchor: "_ConversationStateHandle_createAgentTurn = async function",
    endAnchor: "    const redactedUserMessage = toRedactedUserMessage2(userMessage2, this.privacyMode);",
    find: "    if (userMessage2.simulatedMsgReason !== SimulatedMsgReason.BACKGROUND_TASK_COMPLETION) {\n",
    replacement: `    if (userMessage2.simulatedMsgReason !== SimulatedMsgReason.BACKGROUND_TASK_COMPLETION
      && ${owner}?.isStartupUserMessage(config2.conversationGroupId, userMessage2) !== true) {
`,
  },
  {
    id: "continuity-native-startup-scheduler",
    startAnchor: "var TranscriptManager = class {",
    endAnchor: "  createBackgroundAgent(...args) {",
    find: "  createAgent(...args) {\n",
    replacement: `  async grokboxStartup(request, authorize) {
    const agentId = request.expected.agentId;
    const session = await this.sessions.resolveBackgroundSession(agentId);
    if (!this.execution.isLocalWorkAllowed || !this.execution.canExecute || !await this.execution.isRunReady()) throw new Error("grokbox_startup_not_ready");
    const runner = this.runnerRegistry.getRunner(session);
    const epoch = this.sendPipeline.currentTurnEpoch(session);
    this.runLifecycle.beginSessionRun(session);
    try {
      return await this.runLifecycle.enqueueExclusiveRun(agentId, async () => {
        if (epoch !== this.sendPipeline.currentTurnEpoch(session)) throw new Error("grokbox_startup_superseded");
        await authorize();
        return await ${owner}.startup(request, ticket => runner.run("", {
          grokboxStartupTicket: ticket, requestSource: "event", inferenceRequestId: request.operationId,
          hidden: true, advanceChainOnDelivery: false
        }), () => runner.interrupt("grokbox startup budget reached"));
      }, { lane: "background", source: "event", onCancelled: () => { throw new Error("grokbox_startup_cancelled"); } });
    } finally { this.runLifecycle.endSessionRun(session); }
  }
  createAgent(...args) {
`,
  },
  {
    id: "continuity-native-birth-options",
    startAnchor: "  const mintAgent = async (args) => {",
    endAnchor: "  const deleteAgentsAndReport = async (ids) => {",
    find: "      isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,\n",
    replacement: `      ...${owner}?.birthOptions(),
      isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,
`,
  },
  {
    id: "continuity-native-birth-background",
    startAnchor: "var AgentLifecycle = class {",
    endAnchor: "  async kickstartCreatedAgent(agentId) {",
    find: '  async createAgent(profile, origin = "user", options2 = {}) {\n',
    replacement: `  async createAgent(profile, origin = "user", options2 = {}) {
    if (options2.grokboxBirthOperation !== undefined) return await this.createBackgroundAgent(profile, origin, options2);
`,
  },
  {
    id: "continuity-native-birth-fence",
    startAnchor: "  async mintAgentSession(profile, origin, options2) {",
    endAnchor: "  async kickstartAgent(agentId, isRunReady) {",
    find: '    if (options2.isIntroductionSuppressed !== true && options2.harness !== "temporal") {\n',
    replacement: `    ${owner}?.stageBirth(session.id, options2.grokboxBirthOperation);
    if (options2.isIntroductionSuppressed !== true && options2.harness !== "temporal") {
`,
  },
  {
    id: "continuity-native-prepared-load",
    startAnchor: "var TranscriptManager = class {",
    endAnchor: "  createBackgroundAgent(...args) {",
    find: "  createAgent(...args) {\n",
    replacement: `  async grokboxLoadPrepared(agentId) {
    const raw = this.sessionStore.conversationState.withReadOnlyAgentDb(agentId, db => db.readKv("grokbox.current-state.v1"));
    const state = raw === null ? null : JSON.parse(raw);
    if (state?.version !== 1 || !(state.birth === true || state.application != null)) throw new Error("grokbox_not_prepared");
    const session = await this.sessions.resolveBackgroundSession(agentId);
    this.runnerRegistry.getRunner(session);
    return { agentId };
  }
  createAgent(...args) {
`,
  },
];
