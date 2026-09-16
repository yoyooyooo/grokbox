import { EnvelopeError, WIRE_VERSION, WireError, StreamEvidence, annotateStreamFailure, streamFailureDiagnostic, annotateFailureSummary, projectFailureSummary, failureSummaryMatches, type HostEpoch, type ModelEnvelope } from "@grokbox/runtime-kernel/contract";
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
    wireVersion: `v${WIRE_VERSION}`,
  };
}

/** Unbound fallback only: one system message → state-root; explicit independentRoot → independent. No fixture default. Known compile snapshot-root contracts bind in the session hook instead of this relabel. */
export function inferRootFromHostSelection(envelope: ModelEnvelope, independentRoot?: string) {
  if (typeof independentRoot === "string" && independentRoot.length > 0) {
    return { profileId: "t21-independent-root", abiIdentity: "host-abi-v1", independentRoot };
  }
  const systems = envelope.messages.filter((message) => message.role === "system");
  if (systems.length === 1) {
    return { profileId: "t21-state-root", abiIdentity: "host-abi-v1" };
  }
  throw new EnvelopeError("invalid_envelope");
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
  binding: HostBinding;
  bridgeDigest: string;
  turnId: string;
  profileId?: string;
  abiIdentity?: string;
  independentRoot?: string;
  onConnectAttempt?: (result: "ok" | "fail") => void;
  onFirstChunk?: (stepId: string) => void;
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
      try {
        const health = await requestModeld(input.runRoot, { version: WIRE_VERSION, method: "health" });
        const frame = health[0];
        if (isRecord(frame) && frame.ok === false && isRecord(frame.error) && typeof frame.error.code === "string") {
          throw new VisibleStreamError("admit", frame.error.code);
        }
        if (!isRecord(frame) || typeof frame.serverGeneration !== "string") {
          input.onConnectAttempt?.("fail");
          throw new VisibleStreamError("admit", "model_error");
        }
        input.onConnectAttempt?.("ok");
        last.serviceEpoch = frame.serverGeneration;
      } catch (error) {
        if (error instanceof VisibleStreamError) throw error;
        if (error instanceof WireError && error.code === "unsupported_version") throw new VisibleStreamError("admit", "unsupported_version");
        input.onConnectAttempt?.("fail");
        throw new VisibleStreamError("admit", "model_error");
      }
    }
    let snapshot;
    let hostEpoch: HostEpoch;
    try {
      const root = input.profileId && input.abiIdentity
        ? { profileId: input.profileId, abiIdentity: input.abiIdentity, independentRoot: input.independentRoot }
        : inferRootFromHostSelection(request.envelope, input.independentRoot);
      snapshot = snapshotFromEnvelope(request.envelope, root);
      hostEpoch = hostEpochFromFacts({ binding: input.binding, profileId: root.profileId, bridgeDigest: input.bridgeDigest });
    } catch (error) {
      if (error instanceof EnvelopeError) throw new VisibleStreamError("admit", error.code);
      throw error;
    }
    const aux = request.aux;
    if (aux) {
      if (aux.parent.agentId !== input.agentId || aux.parent.turnId !== input.turnId
        || aux.parent.modelId !== input.modelId || aux.parent.selectionRevision !== input.selectionRevision) {
        throw new VisibleStreamError("admit", "invalid_envelope");
      }
      if (!seen.has(aux.parent.stepId)) throw new VisibleStreamError("admit", "invalid_envelope");
      if (request.envelope.tools.length > 0) throw new VisibleStreamError("admit", "invalid_tools");
    }
    const stepId = aux ? aux.auxRequestId : (typeof request.invocationId === "string" ? request.invocationId : "");
    if (!stepId) throw new VisibleStreamError("admit", "invalid_envelope");
    const prior = seen.get(stepId);
    if (prior && prior !== snapshot.snapshotDigest) {
      throw new VisibleStreamError("admit", "invocation_conflict");
    }
    seen.set(stepId, snapshot.snapshotDigest);
    last.stepId = stepId;
    const names = declared(request.envelope);
    const evidence = new StreamEvidence();
    evidence.setCount("declaredTools", names.size);
    const body: Record<string, unknown> = {
      version: WIRE_VERSION,
      method: "run-step",
      hostEpoch,
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
      version: WIRE_VERSION,
      method: "cancel-step",
      hostEpoch,
      serviceEpoch: { incarnationId: last.serviceEpoch },
      agentId: input.agentId,
      turnId: input.turnId,
      stepId,
    };
    let finished = false;
    let admitted = false;
    let observedChunk = false;
    const rejected = (code: string, raw: unknown, fallbackStage: "admit" | "provider") => {
      const summary = projectFailureSummary(raw);
      const valid = summary && failureSummaryMatches(summary, { agentId: input.agentId, turnId: input.turnId, stepId,
        hostGenerationId: hostEpoch.compile, serviceEpoch: last.serviceEpoch,
        ...(admitted ? { bindingId: last.bindingId } : {}) }, code);
      const phase = valid ? summary.phase : undefined;
      const stage = phase === "admission" || phase === "prepare" || phase === "auth" ? "admit"
        : phase === "authority" ? "authority" : phase === "normalize" ? "normalize" : fallbackStage;
      const error = new VisibleStreamError(stage, code);
      annotateStreamFailure(error, { rejectSite: "host_terminal", ...(valid ? summary.diagnostic : {}),
        failureSummaryStatus: raw === undefined ? "absent" : !summary ? "invalid" : valid ? "direct" : "identity_mismatch" });
      if (valid) annotateFailureSummary(error, summary);
      return error;
    };
    try {
      for await (const frame of streamModeld(input.runRoot, body, { signal: request.abortSignal })) {
        if (!isRecord(frame)) continue;
        if (frame.ok === true && frame.kind === "accepted" && typeof frame.bindingId === "string") {
          admitted = true;
          last.bindingId = frame.bindingId;
          continue;
        }
        if (frame.kind === "event") {
          evidence.note("wire", isRecord(frame.event) ? frame.event.type : "unknown");
          evidence.increment("hostEvents");
          const wireSequence = typeof frame.sequence === "number" ? frame.sequence : undefined;
          const reshaped = reshapeInferenceEvent(frame.event);
          if (reshaped.kind === "invalid") throw annotateStreamFailure(new VisibleStreamError("normalize", "invalid_stream"), { normalizeCause: "invalid_event_shape", rejectSite: "host_event", wireSequence });
          if (reshaped.kind === "ignore") continue;
          const part = reshaped.part;
          if ((part.type === "tool-call" || part.type === "tool-call-delta" || part.type === "tool-call-streaming-start") && !names.has(part.toolName)) {
            throw annotateStreamFailure(new VisibleStreamError("normalize", "invalid_stream"), { normalizeCause: "undeclared_tool", rejectSite: "host_tool", declaredToolMatch: false, wireSequence });
          }
          const hasContent = (part.type !== "text-delta" && part.type !== "reasoning") || part.textDelta.length > 0;
          if (!observedChunk && hasContent) {
            observedChunk = true;
            try { input.onFirstChunk?.(stepId); } catch { /* Observation cannot fail inference. */ }
          }
          yield part;
          continue;
        }
        if (frame.kind === "terminal") {
          const mapped = finishFromTerminal(frame);
          if (!mapped) throw annotateStreamFailure(new VisibleStreamError("normalize", "invalid_stream"), { normalizeCause: "invalid_terminal", rejectSite: "host_terminal" });
          if (mapped.reason === "error") {
            throw rejected(typeof frame.code === "string" ? frame.code : "model_error", frame.failure, "provider");
          }
          finished = true;
          yield { type: "finish", reason: mapped.reason, finishReason: mapped.reason, ...(mapped.usage ? { usage: mapped.usage } : {}) };
          return;
        }
        if (frame.ok === false && isRecord(frame.error) && typeof frame.error.code === "string") {
          const stage = admitted ? "provider" : "admit";
          throw rejected(frame.error.code, frame.error.failure, stage);
        }
      }
      if (!request.abortSignal.aborted && !finished) throw annotateStreamFailure(new VisibleStreamError("normalize", "invalid_stream"), { normalizeCause: "missing_finish", rejectSite: "host_terminal" });
    } catch (error) {
      if (error instanceof WireError || streamFailureDiagnostic(error) || (error instanceof Error && error.message === "extra_keys")) {
        const failure = error instanceof VisibleStreamError ? error : new VisibleStreamError("normalize", "invalid_stream");
        throw annotateStreamFailure(failure, { ...streamFailureDiagnostic(error), stream: evidence.snapshot() });
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
