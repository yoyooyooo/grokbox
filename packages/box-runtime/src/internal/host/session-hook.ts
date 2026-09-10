import { modelForAgent } from "@grokbox/runtime-kernel/selection";
import type { HostBinding } from "./host-binding.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import { captureHostSelection, loadModelsFileSync } from "./selection.node.ts";
import { createModeldProduce } from "./modeld-produce.node.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  visibleFailureHandle,
  type HostStreamRejectDetail,
  type PromptSession,
  type StreamHandle,
} from "./session.ts";
import { appendHostJournal, appendHostStreamRejected } from "./terminal-journal.node.ts";

export type SeamMode = "observe" | "identity" | "route";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Entry interceptor: undefined declines, letting the unchanged Host construct its official session.
 * Identity/observe and route + unassigned agent decline (S4.1).
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
  originalSession?: unknown;
  sessionOptions?: unknown;
  agentId?: string;
  onRequestId?: (id: string) => void;
}) => unknown {
  if (input.mode !== "route") return (args) => args.originalSession;
  return (args) => {
    const options = isRecord(args.sessionOptions) ? args.sessionOptions : {};
    const agentId = boundedId(args.agentId) ?? boundedId(options.agentId);
    const turnId = boundedId(options.invocationId);
    const independentRoot = typeof options.independentRoot === "string" ? options.independentRoot : undefined;
    const bridgeDigest = input.compile?.transformedSha256 ?? boundedId(options.bridgeDigest);
    const onRequestId = typeof args.onRequestId === "function" ? args.onRequestId : undefined;
    const generationId = input.binding?.generationId;
    const facts = {
      ...(generationId ? { hostGenerationId: generationId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(turnId ? { turnId } : {}),
    };
    void appendHostJournal(input.runRoot, {
      name: "host_seam_stage",
      schemaVersion: 1,
      at: nowIso(),
      stage: "hook_enter",
      result: "entered",
      ...facts,
    });
    // A real hook entry remains observable even if selection declines or lacks an agent id.
    const captured = captureHostSelection(input.durableRoot, agentId);
    if (captured.kind === "official") return args.originalSession;
    const modelId = captured.modelId;
    const writeReject = (stage: string, reason: string, errorCode = "invalid_envelope") => {
      if (!agentId) return;
      void appendHostStreamRejected(input.runRoot, {
        name: "host_stream_rejected",
        schemaVersion: 2,
        at: nowIso(),
        mode: "route",
        ...facts,
        stage,
        errorCode,
        reason,
      });
    };
    const writeStage = (stage: string, result: string, extra: Record<string, string> = {}) => {
      void appendHostJournal(input.runRoot, {
        name: "host_seam_stage",
        schemaVersion: 1,
        at: nowIso(),
        stage,
        result,
        ...facts,
        ...extra,
      });
    };
    const reject = (code: string, detail?: HostStreamRejectDetail): StreamHandle => {
      const stage = detail?.stage
        ?? (detail?.reason === "missing-step-id" || detail?.reason === "invalid-step-id" ? "stream-id" : "admit");
      const reason = detail?.reason
        ?? (stage === "admit" ? "invalid-state" : undefined);
      if (reason) writeReject(stage, reason, code);
      return visibleFailureHandle(modelId, code);
    };
    const wrapStream = (session: PromptSession): PromptSession => ({
      stream(request) {
        const stepId = boundedId(request?.invocationId);
        writeStage("stream_enter", "entered", stepId ? { stepId } : {});
        return session.stream(request);
      },
    });
    if (!turnId) {
      writeReject("admit", "missing-turn");
      return asHostPromptSession(wrapStream({
        stream: () => visibleFailureHandle(modelId, "invalid_envelope"),
      }), modelId, onRequestId, { requireStepId: true, reject });
    }
    if (!agentId) {
      writeReject("admit", "missing-binding");
      return asHostPromptSession(wrapStream({
        stream: () => visibleFailureHandle(modelId, "invalid_envelope"),
      }), modelId, onRequestId, { requireStepId: true, reject });
    }
    if (!input.binding) {
      writeReject("admit", "missing-binding");
      return asHostPromptSession(wrapStream({
        stream: () => visibleFailureHandle(modelId, "invalid_envelope"),
      }), modelId, onRequestId, { requireStepId: true, reject });
    }
    if (!bridgeDigest) {
      writeReject("admit", "missing-bridge");
      return asHostPromptSession(wrapStream({
        stream: () => visibleFailureHandle(modelId, "invalid_envelope"),
      }), modelId, onRequestId, { requireStepId: true, reject });
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
      onConnectAttempt: (result) => writeStage("connect_attempt", result),
      onFirstChunk: (stepId) => writeStage("first_chunk", "ok", { stepId }),
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
          at: nowIso(),
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
    return asHostPromptSession(wrapStream(session), modelId, onRequestId, {
      requireStepId: true, reject, contextWindowTokens: record?.contextWindowTokens,
    });
  };
}
