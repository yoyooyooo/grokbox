// Independently authored executable model of the new action-only branch.
// No native source, network, real Bot, or provider implementation is included.
const RESUME_TURN_ACTION = { kind: "resume" };
const SUMMARIZE_ACTION = { kind: "idle-summary" };
class ConversationAction { constructor(value) { Object.assign(this, value); } }
class SummarizeAction {}
class UserMessageAction { constructor(value) { Object.assign(this, value); } }
class UserMessage { constructor(value) { Object.assign(this, value); } }
class SandEmptyPromptError extends Error {}
function createIdleCompactionCollector() { return {}; }
function createTurnRunShell(host) {
  async function run(prompt, options2 = {}) {
      const trimmedPrompt = prompt.trim();
      const selectedImageInputs = options2.selectedImages ?? [];
      const attachedFilePaths = options2.attachedFilePaths ?? [];
      const selectedVideoInputs = options2.selectedVideos ?? [];
      const resumeTurn = options2.resumeTurn === true;
      const idleCompaction = options2.idleCompaction === void 0 ? void 0 : createIdleCompactionCollector();
      const promptlessAction = idleCompaction !== void 0 ? SUMMARIZE_ACTION : RESUME_TURN_ACTION;
      const actionOnly = resumeTurn || idleCompaction !== void 0;
      if (!actionOnly && trimmedPrompt.length === 0 && selectedImageInputs.length === 0 && attachedFilePaths.length === 0 && selectedVideoInputs.length === 0) {
        throw new SandEmptyPromptError();
      }
      const instructionsUpdate = actionOnly ? null : "fresh-instructions";
        const {
          action,
          automationStatusReminder,
          automationStatusCompactionEpoch,
          prependedUserMessageDedupeFloorMessageId
        } = actionOnly ? {
          action: promptlessAction,
          automationStatusReminder: null,
          automationStatusCompactionEpoch: 0,
          prependedUserMessageDedupeFloorMessageId: void 0
        } : await host.promptGlue.assembleTurnAction({ trimmedPrompt, options: options2 });
      return { action, instructionsUpdate, automationStatusReminder, automationStatusCompactionEpoch, prependedUserMessageDedupeFloorMessageId };
  }
  return { run };
}
var SandAgentRunner = class _SandAgentRunner {};
class AbstractUserMessageActionHandler {}
var requestIdKey = Symbol("request-id");
async function getRequestContext() { return { repositoryInfo: [] }; }
function buildRequestContextOptions(config) { return config; }
class FileOperationLockManager {}
const AgentMode = { AGENT: "agent" };
var SummarizeActionHandler = class {
  constructor(config) { this.config = config; }
  async handle(ctx, _action, rootPromptExecutor, stateHandler, mcpTools, onStateUpdate) {
    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;
    if (!hasAnyMessages) return stateHandler.computeNewStructure(ctx);
    if (this.config.summarizeActionMode === "threshold") return { kind: "native-idle-threshold", tools: mcpTools };
    return { kind: "native-explicit-summary" };
  }
};
var ResumeActionHandler = class extends AbstractUserMessageActionHandler {};
module.exports = { createTurnRunShell, SummarizeActionHandler, SandEmptyPromptError, RESUME_TURN_ACTION, SUMMARIZE_ACTION };
