// Independently authored synchronous disposal ABI and complete local lifetime.
// The matcher knows their reviewed digests, not these variable names. Neither
// helper is copied from the private Host or substitutes for its native ABI test.
const addResource = function (scope, value, asynchronous) {
  if (asynchronous !== false) throw new Error("sync-only");
  const dispose = value[Symbol.dispose];
  if (typeof dispose !== "function") throw new TypeError("not-disposable");
  scope.stack.push({ value, dispose });
  return value;
};
const disposeResources = function (scope) {
  let failed = scope.hasError, error = scope.error;
  while (scope.stack.length) {
    const item = scope.stack.pop();
    try { item.dispose.call(item.value); }
    catch (cause) { error = failed ? new AggregateError([cause, error]) : cause; failed = true; }
  }
  if (failed) throw error;
};
function main(host, options, turnId, emit) {
  const mainOptions = { agentId: host.getConversationId(), invocationId: turnId, clientNonce: options.clientNonce };
  return host.inference.createSession(emit, mainOptions);
}
function shouldRetryTurnAttempt(input) {
  const failed = globalThis[Symbol.for("grokbox.box-runtime.managed-failure.v1")];
  if (typeof failed === "function" && failed(input.error)) return false;
  return input.error.retry === true;
}
async function step(ctx, stateHandler, rootPromptExecutor, onStateUpdate) {
  const env = { stack: [], error: void 0, hasError: false };
  try {
    let result;
    const compact = globalThis[Symbol.for("grokbox.box-runtime.host-compact.v1")];
    if (typeof compact === "function") {
      let active = true;
      const lease = compact({ ctx, stateHandler, rootPromptExecutor,
        stepClosed: () => !active,
        contextCheckpoint: async () => {
          if (typeof onStateUpdate !== "function") throw new Error("checkpoint_unavailable");
          await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));
        }
      });
      if (lease != null) {
        const slot = { [Symbol.dispose]() {
          active = false;
          lease[Symbol.dispose]();
        } };
        addResource(env, slot, false);
        if (typeof lease.preflight === "function") await lease.preflight();
      }
    }
    result = rootPromptExecutor.executeToolStream(ctx);
    const response = await result.response;
    return response;
  } catch (caught) {
    env.error = caught;
    env.hasError = true;
  } finally {
    disposeResources(env);
  }
}
module.exports = { main, shouldRetryTurnAttempt, step };
