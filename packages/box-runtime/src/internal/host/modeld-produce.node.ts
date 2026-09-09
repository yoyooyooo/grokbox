import type { HostEpoch, ModelEnvelope } from "@grokbox/runtime-kernel/contract";
import { hostToContextSnapshot } from "./context-codec.ts";
import { requestModeld, streamModeld } from "./modeld-client.node.ts";
import type { HostBinding } from "./host-binding.ts";
import { finishFromTerminal, reshapeInferenceEvent } from "./stream-codec.ts";
import { VisibleStreamError, type StreamPart, type StreamRequest } from "./session.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hostEpochFromBinding(binding?: HostBinding): HostEpoch {
  if (!binding) {
    return {
      compile: "unbound",
      source: "unbound",
      profile: "t21-independent-root",
      hostIdentity: "unbound",
      bridgeDigest: "unbound",
      wireVersion: "v3",
    };
  }
  return {
    compile: binding.generationId,
    source: binding.sourceSha,
    profile: binding.activationId,
    hostIdentity: binding.identitySha,
    bridgeDigest: binding.generationId,
    wireVersion: "v3",
  };
}

function snapshotFromEnvelope(envelope: ModelEnvelope, independentRoot = "required-root-once") {
  const hasSystem = envelope.messages.some((message) => message.role === "system");
  if (hasSystem) {
    return hostToContextSnapshot({
      profileId: "t21-state-root",
      abiIdentity: "host-abi-v1",
      state: envelope.messages,
      tools: envelope.tools,
      options: envelope.options,
    });
  }
  return hostToContextSnapshot({
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    state: envelope.messages,
    tools: envelope.tools,
    options: envelope.options,
    independentRoot,
  });
}

export type ModeldProduceInput = {
  runRoot: string;
  agentId: string;
  modelId: string;
  selectionRevision: string;
  hostEpoch: HostEpoch;
  turnId?: string;
  independentRoot?: string;
};

export function createModeldProduce(input: ModeldProduceInput) {
  let bindingId: string | undefined;
  let serviceEpoch: string | undefined;
  const seen = new Map<string, string>();
  return async function* produce(request: StreamRequest & { envelope: ModelEnvelope; abortSignal: AbortSignal }): AsyncIterable<StreamPart> {
    if (!serviceEpoch) {
      const health = await requestModeld(input.runRoot, { version: 3, method: "health" });
      const frame = health[0];
      if (!isRecord(frame) || typeof frame.serverGeneration !== "string") {
        throw new VisibleStreamError("admit", "model_error");
      }
      serviceEpoch = frame.serverGeneration;
    }
    const snapshot = snapshotFromEnvelope(request.envelope, input.independentRoot);
    const stepId = typeof request.invocationId === "string" ? request.invocationId : "";
    if (!stepId) throw new VisibleStreamError("admit", "invalid_envelope");
    const prior = seen.get(stepId);
    if (prior && prior !== snapshot.snapshotDigest) {
      throw new VisibleStreamError("admit", "invocation_conflict");
    }
    seen.set(stepId, snapshot.snapshotDigest);
    const body: Record<string, unknown> = {
      version: 3,
      method: "run-step",
      hostEpoch: input.hostEpoch,
      serviceEpoch: { incarnationId: serviceEpoch },
      agentId: input.agentId,
      turnId: input.turnId ?? "turn-1",
      stepId,
      selection: {
        agentId: input.agentId,
        modelId: input.modelId,
        selectionRevision: input.selectionRevision,
      },
      snapshot,
    };
    if (bindingId) body.bindingId = bindingId;
    const cancel = {
      version: 3,
      method: "cancel-step",
      hostEpoch: input.hostEpoch,
      serviceEpoch: { incarnationId: serviceEpoch },
      agentId: input.agentId,
      turnId: input.turnId ?? "turn-1",
      stepId,
    };
    let finished = false;
    try {
      for await (const frame of streamModeld(input.runRoot, body, { signal: request.abortSignal })) {
        if (!isRecord(frame)) continue;
        if (frame.ok === true && frame.kind === "accepted" && typeof frame.bindingId === "string") {
          bindingId = frame.bindingId;
          continue;
        }
        if (frame.kind === "event") {
          const part = reshapeInferenceEvent(frame.event);
          if (part) yield part;
          continue;
        }
        if (frame.kind === "terminal") {
          const mapped = finishFromTerminal(frame);
          if (!mapped || mapped.reason === "error") {
            throw new VisibleStreamError("provider", typeof frame.code === "string" ? frame.code : "model_error");
          }
          yield { type: "finish", reason: mapped.reason, finishReason: mapped.reason, ...(mapped.usage ? { usage: mapped.usage } : {}) };
          finished = true;
          return;
        }
        if (frame.ok === false && isRecord(frame.error) && typeof frame.error.code === "string") {
          const stage = frame.error.code === "not_admitted" || frame.error.code === "invalid_envelope" ? "admit" : "provider";
          throw new VisibleStreamError(stage, frame.error.code);
        }
      }
      if (!request.abortSignal.aborted && !finished) throw new VisibleStreamError("normalize", "invalid_stream");
    } finally {
      if (request.abortSignal.aborted && !finished) {
        await requestModeld(input.runRoot, cancel, 500).catch(() => undefined);
      }
    }
  };
}
