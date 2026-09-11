/** Minimal Host-shaped source that matches LIVE_SLICE_PATCHES anchors (offline fixture). */
export const LIVE_SHAPED_HOST = `"use strict";
const api = {
  createSession(onRequestId, sessionOptions) {
    const inferenceOptions = { sessionOptions, onRequestId };
    if (false) {
      void 0;
    }
      return createCursorInferencePromptSession(inferenceOptions);
    },
    recordPostTurnLabeling(args) {
      return args;
    },
};
function runTurn(host) {
  const inferenceRequestId = "inv-live-shaped";
  const emitRequestId = () => inferenceRequestId;
  const mainSessionOptions = {
    inferenceReason: "main",
          modelId: host.subagentModelId,
    tools: true,
  };
  return (async () => host.inference.createSession(emitRequestId, mainSessionOptions))();
}
const compactOwner = {
  async runStep() {
    const env_2 = { stack: [], error: void 0, hasError: false };
    const ctx = { get() { return "turn-live-shaped"; } };
    let stepClosed = false;
      let response;
      let extendedUsage;
      let usage;
      let finalInvocationId;
      try {
        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([
          Promise.resolve(), Promise.resolve(), Promise.resolve(), Promise.resolve()
        ]);
      } finally {
        stepClosed = true;
      }
    return { response, env_2, ctx };
  },
};
function attachListener(host, streamWatchdog, updateObservers) {
  return new ForwardingInteractionListener(
          (update) => {
            streamWatchdog.noteUpdate(update);
            host.emitUpdate(update, updateObservers);
          },
          {
            onToolCall: (event, callId, toolCall) => {
              return { event, callId, toolCall };
            },
          },
  );
}
module.exports = { api, runTurn, compactOwner, attachListener };
`;
