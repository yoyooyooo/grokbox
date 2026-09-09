import { EnvelopeError, type HostEpoch, type ModelEnvelope } from "@grokbox/runtime-kernel/contract";
import { hostToContextSnapshot } from "./context-codec.ts";
import { qualifyHostRootContract } from "./root-contract.ts";
import { requestModeld, streamModeld } from "./modeld-client.node.ts";
import type { HostBinding } from "./host-binding.ts";
import { finishFromTerminal, reshapeInferenceEvent } from "./stream-codec.ts";
import { VisibleStreamError, type StreamPart, type StreamRequest } from "./session.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hostEpochFromFacts(input: {
  binding: HostBinding;
  profileId: string;
  bridgeDigest: string;
}): HostEpoch {
  return {
    compile: input.binding.generationId,
    source: input.binding.sourceSha,
    profile: input.profileId,
    hostIdentity: input.binding.identitySha,
    bridgeDigest: input.bridgeDigest,
    wireVersion: "v3",
  };
}

export function snapshotFromEnvelope(envelope: ModelEnvelope, input: {
  profileId: string;
  abiIdentity: string;
  independentRoot?: string;
}) {
  const contract = qualifyHostRootContract(input.profileId, input.abiIdentity);
  if (contract.rootSource === "independent") {
    if (typeof input.independentRoot !== "string" || input.independentRoot.length === 0) {
      throw new EnvelopeError("invalid_envelope");
    }
    return hostToContextSnapshot({
      profileId: input.profileId,
      abiIdentity: input.abiIdentity,
      state: envelope.messages,
      tools: envelope.tools,
      options: envelope.options,
      independentRoot: input.independentRoot,
    });
  }
  return hostToContextSnapshot({
    profileId: input.profileId,
    abiIdentity: input.abiIdentity,
    state: envelope.messages,
    tools: envelope.tools,
    options: envelope.options,
  });
}

export type ModeldProduceInput = {
  runRoot: string;
  agentId: string;
  modelId: string;
  selectionRevision: string;
  hostEpoch: HostEpoch;
  turnId: string;
  profileId: string;
  abiIdentity: string;
  independentRoot?: string;
};

export type ModeldProduceRuntime = {
  produce: (request: StreamRequest & { envelope: ModelEnvelope; abortSignal: AbortSignal }) => AsyncIterable<StreamPart>;
  last: { serviceEpoch?: string; bindingId?: string; stepId?: string };
};

export function createModeldProduce(input: ModeldProduceInput): ModeldProduceRuntime {
  const last: ModeldProduceRuntime["last"] = {};
  const seen = new Map<string, string>();
  const declared = (envelope: ModelEnvelope) => new Set(envelope.tools.map((tool) => tool.name));
  const produce = async function* (request: StreamRequest & { envelope: ModelEnvelope; abortSignal: AbortSignal }): AsyncIterable<StreamPart> {
    if (!last.serviceEpoch) {
      const health = await requestModeld(input.runRoot, { version: 3, method: "health" });
      const frame = health[0];
      if (!isRecord(frame) || typeof frame.serverGeneration !== "string") {
        throw new VisibleStreamError("admit", "model_error");
      }
      last.serviceEpoch = frame.serverGeneration;
    }
    let snapshot;
    try {
      snapshot = snapshotFromEnvelope(request.envelope, {
        profileId: input.profileId,
        abiIdentity: input.abiIdentity,
        independentRoot: input.independentRoot,
      });
    } catch (error) {
      if (error instanceof EnvelopeError) throw new VisibleStreamError("admit", error.code);
      throw error;
    }
    const stepId = typeof request.invocationId === "string" ? request.invocationId : "";
    if (!stepId) throw new VisibleStreamError("admit", "invalid_envelope");
    const prior = seen.get(stepId);
    if (prior && prior !== snapshot.snapshotDigest) {
      throw new VisibleStreamError("admit", "invocation_conflict");
    }
    seen.set(stepId, snapshot.snapshotDigest);
    last.stepId = stepId;
    const names = declared(request.envelope);
    const body: Record<string, unknown> = {
      version: 3,
      method: "run-step",
      hostEpoch: input.hostEpoch,
      serviceEpoch: { incarnationId: last.serviceEpoch },
      agentId: input.agentId,
      turnId: input.turnId,
      stepId,
      selection: {
        agentId: input.agentId,
        modelId: input.modelId,
        selectionRevision: input.selectionRevision,
      },
      snapshot,
    };
    if (last.bindingId) body.bindingId = last.bindingId;
    const cancel = {
      version: 3,
      method: "cancel-step",
      hostEpoch: input.hostEpoch,
      serviceEpoch: { incarnationId: last.serviceEpoch },
      agentId: input.agentId,
      turnId: input.turnId,
      stepId,
    };
    let finished = false;
    try {
      for await (const frame of streamModeld(input.runRoot, body, { signal: request.abortSignal })) {
        if (!isRecord(frame)) continue;
        if (frame.ok === true && frame.kind === "accepted" && typeof frame.bindingId === "string") {
          last.bindingId = frame.bindingId;
          continue;
        }
        if (frame.kind === "event") {
          const reshaped = reshapeInferenceEvent(frame.event);
          if (reshaped.kind === "invalid") throw new VisibleStreamError("normalize", "invalid_stream");
          if (reshaped.kind === "ignore") continue;
          const part = reshaped.part;
          if ((part.type === "tool-call" || part.type === "tool-call-delta" || part.type === "tool-call-streaming-start") && !names.has(part.toolName)) {
            throw new VisibleStreamError("normalize", "invalid_stream");
          }
          yield part;
          continue;
        }
        if (frame.kind === "terminal") {
          const mapped = finishFromTerminal(frame);
          if (!mapped || mapped.reason === "error") {
            throw new VisibleStreamError("provider", typeof frame.code === "string" ? frame.code : "model_error");
          }
          finished = true;
          yield { type: "finish", reason: mapped.reason, finishReason: mapped.reason, ...(mapped.usage ? { usage: mapped.usage } : {}) };
          return;
        }
        if (frame.ok === false && isRecord(frame.error) && typeof frame.error.code === "string") {
          const stage = frame.error.code === "not_admitted" || frame.error.code === "invalid_envelope" ? "admit" : "provider";
          throw new VisibleStreamError(stage, frame.error.code);
        }
      }
      if (!request.abortSignal.aborted && !finished) throw new VisibleStreamError("normalize", "invalid_stream");
    } catch (error) {
      if (error instanceof Error && error.message === "extra_keys") {
        throw new VisibleStreamError("normalize", "invalid_stream");
      }
      throw error;
    } finally {
      if (request.abortSignal.aborted && !finished) {
        await requestModeld(input.runRoot, cancel, 500).catch(() => undefined);
      }
    }
  };
  return { produce, last };
}
