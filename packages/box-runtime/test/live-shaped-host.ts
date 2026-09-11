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
// Independent memory policy fixture: only the small ABI anchor lines mirror Host.
async function runTurnMemory(memoryStore, episodeProgress, session, ctx, turnTs, exchange) {
  if (memoryStore.recordMemoryEvidence) {
    memoryStore.recordMemoryEvidence(exchange);
    return;
  }
  await runMemoryExtraction(memoryStore, session, ctx, exchange);
  const pending = episodeProgress ?? [];
  if (pending.length >= 2) {
      const narrative = await summarizeEpisode({
        executor: session.getExecutor(),
        ctx,
        turns: pending
      });
    memoryStore.addMemory({ purpose: "episode", text: narrative });
  }
}
async function runMemoryExtraction(memoryStore, session, ctx, exchange) {
    const extraction = await extractMemories({
      executor: session.getExecutor(),
      ctx,
      userMessage: exchange.user,
      agentMessage: exchange.agent,
    });
  memoryStore.addMemory({ purpose: "memory-extraction", text: extraction });
}
function blankRoster(profilePath, fileProfile) {
  return {
    ...fileProfile?.namedBy === void 0 ? {} : { namedBy: fileProfile.namedBy },
    ...readSandProfileHarness(profilePath) === "temporal" ? { harness: "temporal" } : {},
    isGroup: false,
    memberIds: []
  };
}
async function buildSummary(args) {
  const { extras, isGroup, memberIds, fileProfile, profilePath } = args;
  return {
    origin: extras?.origin ?? "user",
    ...fileProfile?.namedBy === void 0 ? {} : { namedBy: fileProfile.namedBy },
    isGroup,
    memberIds,
    ...readSandProfileHarness(profilePath) === "temporal" ? { harness: "temporal" } : {}
  };
}
async function agentHasDurableFootprint(agentDir, agentHasMemory) {
  return Boolean(agentDir && agentHasMemory);
}
module.exports = { api, runTurn, compactOwner, attachListener, runTurnMemory, runMemoryExtraction, blankRoster, buildSummary };
`;
