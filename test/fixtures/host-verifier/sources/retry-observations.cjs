// Independent executable boundary fixtures for the current bundle's bindings.
class RetriableError extends Error {}
class NonRetriableError extends Error {}
class ActionRequiredError extends Error {}
class OutputTokensLimitExceededError extends Error {}
class ProactiveSummarizationThresholdError extends Error {}
const classifyError2 = error42 => error42;
function isRetryableProviderError(error42) {
  if (error42 == null) return false;
  if (!(classifyError2(error42) instanceof RetriableError)) return false;
  return true;
}
function unrelatedClassification(classified) {
  if (classified instanceof NonRetriableError || classified instanceof ActionRequiredError) {
    return false;
  }
  return true;
}
class RetryOwner {
  async runWithMaxTokensRetry(
    work
  ) {
        try {
          return await work();
        } catch (error42) {
          if (error42 instanceof OutputTokensLimitExceededError) {
            return { retry: "output", original: error42 };
          }
          throw error42;
        }
  }
  async runWithSummarizationRetry(
    work
  ) {
        try {
          return await work();
        } catch (error42) {
          const isProactiveSummarizationThresholdError = error42 instanceof ProactiveSummarizationThresholdError;
          return { retry: isProactiveSummarizationThresholdError ? "summary" : "native-fallback", original: error42 };
        }
  }
  async runTurnLoop() {}
}
var requestIdKey = Symbol("request");
class ToolOwner {
  constructor() { this.invocationId = "synthetic-step"; }
  withToolCallMetadata(_id, value) { return value; }
  async executeToolCall(parentCtx, toolCall, callId, promiseFn, resultMergeFn, hookContextCollector) {
    const ctx = { get: () => "synthetic-turn" };
    const resolvers = {}; resolvers.promise = new Promise((resolve, reject) => Object.assign(resolvers, { resolve, reject }));
    let result;
      promiseFn(ctx).then((r) => {
        result = r;
        resolvers.resolve(r);
      }).catch((error42) => {
        resolvers.reject(error42);
      });
      const newToolCall = this.withToolCallMetadata(callId, await resolvers.promise, result);
      return newToolCall;
  }
}
function describeAgentRunError(error) { return { errorKind: "synthetic", error }; }
function hostTrayTitle(value) { return { title: value.kind }; }
function turnTrayTitleKind(value) { return value; }
function markTurnTraceError() {}
function isBackgroundAutomationTrigger(trigger) { return trigger === "background"; }
function shouldNotifyAutomationFailure(occurrence) { return occurrence !== "throttled"; }
class AlertOwner {
  constructor() { this.trays = []; this.tm = { sendPipeline: { currentTurnEpoch: () => this.epoch }, trayErrors: { pushError: row => this.trays.push(row) } }; }
  async run(error42, epoch) {
    const session = { id: "synthetic-agent", db: { getRequestIds: () => [{ id: "synthetic-request" }] } };
    const turnTrace = {}, turnMessageIds = [], options2 = { clientNonce: "synthetic-nonce" };
    try { throw error42; } catch (error42) {
        markTurnTraceError(turnTrace, error42);
        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
          const description9 = describeAgentRunError(error42);
          const requestId2 = session.db.getRequestIds().at(-1)?.id;
          this.tm.trayErrors.pushError({
            agentId: session.id,
            requestId: requestId2,
            ...description9,
            ...hostTrayTitle({ kind: turnTrayTitleKind(description9.errorKind), description: description9 })
          });
        }
        void this.trays.length;
      } finally {
        this.forgetTemplateSetupWriteHints(session.id, turnMessageIds);
    }
  }
  forgetTemplateSetupWriteHints() {}
  notifyAutomationFailure(session, automation, trigger2, description9) {
    if (isBackgroundAutomationTrigger(trigger2)) return;
    const occurrence = automation.occurrence;
    if (!shouldNotifyAutomationFailure(occurrence)) return;
    this.trays.push({ agentId: session.id, description: description9 });
  }
  clearAutomationFailureState(agentId, automationId) {}
}
module.exports = { isRetryableProviderError, RetryOwner, ToolOwner, AlertOwner, RetriableError, OutputTokensLimitExceededError, ProactiveSummarizationThresholdError };
