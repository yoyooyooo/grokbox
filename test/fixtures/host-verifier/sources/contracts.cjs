// Independently authored public fixture. Not extracted from a private Host.
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
  const env_2 = {};
  let result;
        result = rootPromptExecutor.executeToolStream(
          ctx
        );
let stepClosed = false;
  return result;
}
// Independent entry registrations, not inferred from a matcher's output.
module.exports = { prepare, inference, shouldRetryTurnAttempt, perform };
