import { modelForAgent } from "@grokbox/runtime-kernel/selection";
import type { HostBinding } from "./host-binding.ts";
import { captureHostSelection, loadModelsFileSync } from "./selection.node.ts";
import { createModeldProduce, hostEpochFromFacts } from "./modeld-produce.node.ts";
import { qualifyHostRootContract } from "./root-contract.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  visibleFailureHandle,
  type PromptSession,
} from "./session.ts";
import { appendHostJournal, appendHostStreamRejected } from "./terminal-journal.node.ts";

export type SeamMode = "observe" | "identity" | "route";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : undefined;
}

function deadSession(modelId: string): PromptSession {
  return { stream: () => visibleFailureHandle(modelId, "invalid_envelope") };
}

/**
 * Identity/observe: official session passthrough.
 * Route + unassigned agent: official passthrough (S4.1).
 * Route + managed assignment: Host fullStream over v3 modeld (T26).
 */
export function bindHostSessionHook(input: {
  mode: SeamMode;
  durableRoot: string;
  runRoot: string;
  binding?: HostBinding;
}): (args: {
  originalSession: unknown;
  sessionOptions?: unknown;
  agentId?: string;
  onRequestId?: (id: string) => void;
}) => unknown {
  if (input.mode !== "route") return (args) => args.originalSession;
  return (args) => {
    const options = isRecord(args.sessionOptions) ? args.sessionOptions : {};
    const agentId = boundedId(args.agentId) ?? boundedId(options.agentId);
    const captured = captureHostSelection(input.durableRoot, agentId);
    if (captured.kind === "official") return args.originalSession;
    const modelId = captured.modelId;
    const turnId = boundedId(options.invocationId);
    const profileId = boundedId(options.profileId);
    const abiIdentity = boundedId(options.abiIdentity);
    const independentRoot = typeof options.independentRoot === "string" ? options.independentRoot : undefined;
    const bridgeDigest = boundedId(options.bridgeDigest);
    const onRequestId = typeof args.onRequestId === "function" ? args.onRequestId : undefined;
    const reject = (code: string, detail?: { invocationId?: unknown; reason?: "missing-step-id" | "invalid-step-id" }) => {
      if (turnId && input.binding && agentId) {
        void appendHostStreamRejected(input.runRoot, {
          name: "host_stream_rejected",
          schemaVersion: 2,
          at: new Date().toISOString(),
          mode: "route",
          hostGenerationId: input.binding.generationId,
          agentId,
          turnId,
          stage: "stream-id",
          errorCode: "invalid_envelope",
          reason: detail?.reason,
        });
      }
      return visibleFailureHandle(modelId, code);
    };
    let rootOk = false;
    if (profileId && abiIdentity) {
      try {
        qualifyHostRootContract(profileId, abiIdentity);
        rootOk = true;
      } catch {
        rootOk = false;
      }
    }
    if (!turnId || !agentId || !input.binding || !profileId || !abiIdentity || !bridgeDigest || !rootOk) {
      return asHostPromptSession(deadSession(modelId), modelId, onRequestId, { requireStepId: true, reject });
    }
    const models = loadModelsFileSync(input.durableRoot);
    const record = models ? modelForAgent(models, agentId) : undefined;
    const vision = record?.capabilities.vision === true || record?.capabilities.images === true
      || (record?.dataTypes ?? []).includes("images");
    const runtime = createModeldProduce({
      runRoot: input.runRoot,
      agentId,
      modelId,
      selectionRevision: captured.selectionRevision,
      turnId,
      profileId,
      abiIdentity,
      independentRoot,
      hostEpoch: hostEpochFromFacts({ binding: input.binding, profileId, bridgeDigest }),
    });
    const session = createStreamingPromptSession({
      modelId,
      vision,
      parallel: "fail-closed",
      produce: runtime.produce,
      agentId,
      onTerminal: (terminal) => {
        void appendHostJournal(input.runRoot, {
          name: "host_normalized_terminal",
          at: new Date().toISOString(),
          hostId: input.binding!.identitySha,
          agentId,
          turnId,
          stepId: terminal.invocationId ?? runtime.last.stepId,
          serviceEpoch: runtime.last.serviceEpoch,
          binding: runtime.last.bindingId,
          attempt: "0",
        });
      },
    });
    return asHostPromptSession(session, modelId, onRequestId, { requireStepId: true, reject });
  };
}
