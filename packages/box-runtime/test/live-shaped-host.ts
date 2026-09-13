import { OWNERSHIP_SHAPED_HOST } from "./ownership-shaped-host.ts";
/** Minimal Host-shaped source that matches LIVE_SLICE_PATCHES anchors (offline fixture). */
export const LIVE_SHAPED_HOST = `"use strict";
${OWNERSHIP_SHAPED_HOST}
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
  async runStep(parentCtx, turn, rootPromptExecutor, stateHandler) {
    const env_2 = { stack: [], error: void 0, hasError: false };
    try {
    const ctx = { get() { return "turn-live-shaped"; } };
    const invocationId = "step-live-shaped";
    stateHandler ??= { backgroundSummarizationPromiseInfo: null };
    const requestContext = {};
    rootPromptExecutor ??= { executeToolStream() { return { extendedUsage: Promise.resolve({}) }; } };
    let result;
        result = rootPromptExecutor.executeToolStream(
          ctx
        );
    const startBackgroundSummary = async () => {};
    if (false) {
        await startBackgroundSummary();
    }
    let stepClosed = false;
      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {
        return currentUsage;
      });
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
    } catch (e_2) {
      env_2.error = e_2;
      throw e_2;
    }
  },
  async runWithMaxTokensRetry(ctx, root, fn) {
    for (let i = 0; i < 2; i++) {
      try { return await fn();
        } catch (error41) {
          if (error41 instanceof OutputTokensLimitExceededError) {
            if (i === 1) throw error41;
          } else throw error41;
        }
    }
  },
  async runWithSummarizationRetry(ctx, state, root, fn) {
    for (let i = 0; i < 2; i++) {
      try { return await fn();
        } catch (error41) {
          const isProactiveSummarizationThresholdError = error41 instanceof ProactiveSummarizationThresholdError;
          if (!isProactiveSummarizationThresholdError || i === 1) throw error41;
        }
    }
  },
  async runTurnLoop() {},
};
function shouldRetryTurnAttempt(input) {
  if (input.canceled) return false;
  return input.automationIsRetryable?.(input.error) ?? true;
}
function computeBackoffDelayMs(params) { return params.delay; }
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
function rpcString() { return "string"; }
function rpcOptional(schema) { return schema; }
function rpcObject(fields) { return fields; }
function rpcUnion(left, right) { return left || right; }
function rpcLiteral(value) { return value; }
const SAND_REQUESTED_AGENT_HARNESS_BOX = "box";
const SAND_REQUESTED_AGENT_HARNESS_TEMPORAL = "temporal";
var agentProfileFields = {
  name: rpcString(),
  description: rpcString(),
  title: rpcOptional(rpcString()),
  avatarShape: rpcOptional(rpcString()),
  avatarColor: rpcOptional(rpcString())
};
var agentProfile = rpcObject(agentProfileFields);
var createAgentArgs = rpcObject({
  ...agentProfileFields,
});
function parseProfileJson2() { return null; }
function profileServerBindingFromJson(parsed) { return parsed || {}; }
function serializeSandProfileFile(profile, binding) { return JSON.stringify({ profile, binding }); }
function writeProfileJson() {}
function readSandProfileCreationMetadata() { return {}; }
function writeSandProfileFile(path31, profile) {
  const parsed = parseProfileJson2(path31);
  writeProfileJson(
    path31,
    serializeSandProfileFile(profile, parsed == null ? {} : profileServerBindingFromJson(parsed))
  );
}
function seedRoomProfileName(seed) {
  return seed;
}
function writeServerBackedProfileFile(path31, profile, binding) {
  const previous = readSandProfileCreationMetadata(path31);
  writeProfileJson(
    path31,
    serializeSandProfileFile(profile, {
      ...binding,
      origin: binding.origin ?? previous.origin,
      purpose: binding.purpose ?? previous.purpose
    })
  );
}
function isServerTemporalHarnessRefusal(error41) {
  return Boolean(error41);
}
const rosterOwner = {
  async updateAgent(agentId, profile) {
    const trimmedProfile = {
      ...profile.avatarShape === void 0 ? {} : { avatarShape: profile.avatarShape.trim() },
      ...profile.avatarColor === void 0 ? {} : { avatarColor: profile.avatarColor.trim() },
      name: profile.name.trim(),
      description: profile.description.trim(),
      ...profile.title === void 0 ? {} : { title: profile.title.trim() }
    };
    return { agentId, trimmedProfile };
  },
  async seedConversationName({
    id,
    prompt
  }) {
    return { id, prompt };
  }
};
const sessionStoreOwner = {
  getAgentDir(agentId) { return agentId; },
  writeAgentProfileFile(agentId, profile) {
    const path31 = getSandProfilePath(this.getAgentDir(agentId));
    const current = readSandProfileFile(path31);
    const trimmedName = profile.name.trim();
    const isRename = trimmedName.length > 0 && trimmedName !== current?.name.trim();
    const namedBy = isRename ? "user" : current?.namedBy;
    writeSandProfileFile(path31, {
      name: resolveProfileName(trimmedName, current),
      description: profile.description.trim(),
      title: profile.title?.trim() ?? current?.title ?? "",
      avatarShape: profile.avatarShape?.trim() ?? current?.avatarShape ?? "",
      avatarColor: profile.avatarColor?.trim() ?? current?.avatarColor ?? "",
      ...namedBy == null ? {} : { namedBy }
    });
  },
  async withAgentDb(agentId, fn) {
    return fn(agentId);
  }
};
function getSandProfilePath(dir) { return dir; }
function readSandProfileFile() { return { name: "fixture" }; }
function resolveProfileName(name) { return name; }
// Independent retry decision fixture; only exact ABI conditions are shared anchors.
class RetriableError extends Error {}
class NonRetriableError extends Error {}
class ActionRequiredError extends Error {}
function classifyError2(error41) { return error41; }
function mayRetry(error41) {
  if (!(classifyError2(error41) instanceof RetriableError)) return false;
  return true;
}
function displayFailure(error41) {
  const classified = classifyError2(error41);
  if (classified instanceof NonRetriableError || classified instanceof ActionRequiredError) {
    return false;
  }
  return true;
}
module.exports = { api, runTurn, compactOwner, attachListener, runTurnMemory, runMemoryExtraction, blankRoster, buildSummary, rosterOwner, sessionStoreOwner, mayRetry, RetriableError };
`;
