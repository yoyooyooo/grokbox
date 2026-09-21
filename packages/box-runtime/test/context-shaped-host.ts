// Owned, deliberately small contracts for the context-control insertion sites.
// This is not a copy of the native runner, queue, summarizer or state store.
export const CONTEXT_SHAPED_HOST = `
function rpcMethod() { return { args(value) { return value; } }; }
const contextFixtureSchema = {
    getHostStatus: rpcMethod().args(hostStatusArgs),
    setBoxMigrating: rpcMethod().args({ migrating: rpcBoolean() }),
};
class ConversationAction { constructor(value) { Object.assign(this, value); } }
class SummarizeAction {}
const RESUME_TURN_ACTION = { action: { case: "resumeAction" } };
const SUMMARIZE_ACTION = { action: { case: "summarizeAction" } };
function createTurnRunShell(host) {
  let cancelActiveRun = null;
  let pausingForUpgrade = false;
  const steer = value => value;
  const interrupt = reason => { cancelActiveRun?.(reason); };
  const interruptAll = interrupt;
  async function run(prompt, options2 = {}) {
      const resumeTurn = options2.resumeTurn === true;
      const idleCompaction = options2.idleCompaction;
      const actionOnly = resumeTurn || idleCompaction !== undefined;
      const promptlessAction = idleCompaction !== undefined ? SUMMARIZE_ACTION : RESUME_TURN_ACTION;
    let aborted2 = false, pausedForUpgrade = false;
    const settle = { settleCompletedTurn: async value => host.onSettled?.(value) };
    const turn = actionOnly ? {
          action: promptlessAction,
          automationStatusReminder: null,
    } : { action: { action: { case: "userMessage", value: prompt } } };
    cancelActiveRun = () => { aborted2 = true; };
    try {
      const result = await host.onRun(prompt, options2, turn);
        if (!aborted2 && !pausedForUpgrade) {
          await settle.settleCompletedTurn({
            result
          });
        }
      return result;
    } finally { cancelActiveRun = null; }
  }
  return {
    run,
    steer,
    interrupt,
    interruptAll,
  };
}
var SandAgentRunner = class _SandAgentRunner {};
var SummarizeActionHandler = class {
  constructor(options) { Object.assign(this, options); }
  async handle(ctx, _action, rootPromptExecutor, stateHandler, mcpTools, onStateUpdate) {
    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;
    return { nativeUnchanged: true, hasAnyMessages };
  }
};
class AbstractUserMessageActionHandler {}
var ResumeActionHandler = class extends AbstractUserMessageActionHandler {};
`;
