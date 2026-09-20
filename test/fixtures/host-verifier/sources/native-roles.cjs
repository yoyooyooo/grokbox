// Independently authored local-wiring oracle. No private Host implementation.
// Names at the native interop boundary identify roles; local variables may vary.
async function traceSendPhase(ctx, label, callback) {
  if (!ctx) return await callback(ctx);
  try { return await callback(ctx); } catch (error) { throw error; }
}
function createTurnRunShell(host) {
  async function run(prompt, options = {}) {
    const result = await runTurn(prompt, options);
    return result;
  }
  async function runTurn(prompt, options) {
    const turn = options.inferenceRequestId ?? crypto.randomUUID();
    const ctx = {};
    const localOptions = {
      agentId: host.getConversationId(), invocationId: turn, clientNonce: options.clientNonce,
      ...(options.useExecutor ? { executorProfile: 'public' } : { modelId: 'native' }),
      ...(options.lineage ? { lineage: options.lineage } : {})
    };
    const session = await traceSendPhase(ctx, 'public-main', async () => host.inference.createSession(() => {}, localOptions));
    const auxiliary = host.inference.createSession(() => {}, { modelId: 'summary', isSummarizationSession: true });
    return { session, auxiliary };
  }
  return { run };
}
function shouldRetryTurnAttempt(input) {
  const failed = globalThis[Symbol.for('grokbox.box-runtime.managed-failure.v1')];
  if (typeof failed === 'function' && failed(input.error)) return false;
  return input.error.retry === true;
}
async function runWithTransientRetry(run, policy) {
  const isRetryable = policy.isRetryable ?? (() => false);
  for (let count = 0; ; count++) {
    try { return await run(); }
    catch (error) { if (count > 1 || !isRetryable(error)) throw error; }
  }
}
function createStreamAttempt(host) {
  const once = async () => host.stream();
  const policy = host.policy;
  const bounded = async () => policy.maxAttempts > 1 ? await runWithTransientRetry(once, {
    ...policy,
    isRetryable: error => shouldRetryTurnAttempt({ error, canceled: false }),
    onRetry: () => {}
  }) : await once();
  const run = async () => { try { return await bounded(); } catch (error) { throw error; } };
  return { run };
}
var AbstractUserMessageActionHandler = class {
  async runStep(ctx, stateHandler, onStateUpdate, rootPromptExecutor) {
    const compact = globalThis[Symbol.for('grokbox.box-runtime.host-compact.v1')];
    if (typeof compact === 'function') {
      const lease = compact({ ctx, stateHandler, contextCheckpoint: async () => {
        if (typeof onStateUpdate !== 'function') throw new Error('checkpoint unavailable');
        await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));
      }});
    }
    return rootPromptExecutor.executeToolStream(ctx);
  }
  async execute(ctx, state, save, executor) {
    return await this.runStep(ctx, state, save, executor);
  }
};
module.exports = { createTurnRunShell, createStreamAttempt, AbstractUserMessageActionHandler };
