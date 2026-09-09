import { modelForAgent } from "@grokbox/runtime-kernel/selection";
import type { HostBinding } from "./host-binding.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import { captureHostSelection, loadModelsFileSync } from "./selection.node.ts";
import { createModeldProduce } from "./modeld-produce.node.ts";
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
 * profile/ABI come from Host-selected root at stream time; bridgeDigest from compile.
 */
export function bindHostSessionHook(input: {
  mode: SeamMode;
  durableRoot: string;
  runRoot: string;
  binding?: HostBinding;
  compile?: CompileReceipt;
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
    const independentRoot = typeof options.independentRoot === "string" ? options.independentRoot : undefined;
    const bridgeDigest = input.compile?.transformedSha256 ?? boundedId(options.bridgeDigest);
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
    if (!turnId || !agentId || !input.binding || !bridgeDigest) {
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
      binding: input.binding,
      bridgeDigest,
      independentRoot,
    });
    const session = createStreamingPromptSession({
      modelId,
      vision,
      parallel: "fail-closed",
      produce: runtime.produce,
      agentId,
      onTerminal: (terminal) => {
        const stepId = terminal.invocationId;
        if (!stepId) return;
        const producedThisStep = runtime.last.stepId === stepId;
        void appendHostJournal(input.runRoot, {
          name: "host_normalized_terminal",
          at: new Date().toISOString(),
          hostId: input.binding!.identitySha,
          agentId,
          turnId,
          stepId,
          ...(producedThisStep
            ? {
              serviceEpoch: runtime.last.serviceEpoch,
              binding: runtime.last.bindingId,
              attempt: "0",
            }
            : {}),
        });
      },
    });
    return asHostPromptSession(session, modelId, onRequestId, { requireStepId: true, reject });
  };
}
