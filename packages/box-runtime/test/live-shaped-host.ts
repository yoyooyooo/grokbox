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
module.exports = { api, runTurn };
`;
