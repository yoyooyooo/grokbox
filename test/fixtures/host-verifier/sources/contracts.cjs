// Independently authored public fixture. Not extracted from a private Host.
const __addDisposableResource22 = function (scope, value, asynchronous) {
  if (asynchronous !== false) throw new Error("sync-only");
  const dispose = value[Symbol.dispose];
  if (typeof dispose !== "function") throw new TypeError("not-disposable");
  scope.stack.push({ value, dispose });
  return value;
};
const __disposeResources22 = function (scope) {
  let failed = scope.hasError, error = scope.error;
  while (scope.stack.length) {
    const item = scope.stack.pop();
    try { item.dispose.call(item.value); }
    catch (cause) { error = failed ? new AggregateError([cause, error]) : cause; failed = true; }
  }
  if (failed) throw error;
};
function prepare(host, options2, inferenceRequestId, emitRequestId) {
  const mainSessionOptions = {
    modelId: "native"
  };
  return async () => host.inference.createSession(emitRequestId, mainSessionOptions);
}
const inference = {
    createSession(onRequestId, sessionOptions) {
      const inferenceOptions = { onRequestId, sessionOptions };
      return createCursorInferencePromptSession(inferenceOptions);
    },
    recordPostTurnLabeling(args) { return args; }
};
function shouldRetryTurnAttempt(input) {
  return input.error.retry === true;
}
function computeBackoffDelayMs(params) { return params.delay; }
async function perform(ctx, stateHandler, rootPromptExecutor, onStateUpdate, requestContext, invocationId, toolSetHandle) {
  const env_2 = { stack: [], error: void 0, hasError: false };
  try {
    let result;
        result = rootPromptExecutor.executeToolStream(
          ctx
        );
let stepClosed = false;
    const response = await result.response;
    stepClosed = true;
    return response;
  } catch (caught) {
    env_2.error = caught;
    env_2.hasError = true;
  } finally {
    __disposeResources22(env_2);
  }
}
// Independent entry registrations, not inferred from a matcher's output.
module.exports = { prepare, inference, shouldRetryTurnAttempt, perform };
