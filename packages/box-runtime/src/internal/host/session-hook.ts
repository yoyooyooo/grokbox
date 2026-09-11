import type { HostBinding } from "./host-binding.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import { captureHostManagedSelection } from "./selection.node.ts";
import { createModeldProduce } from "./modeld-produce.node.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  visibleFailureHandle,
  toHostStreamResult,
  type HostPromptExecutor,
  type HostPromptSession,
  type HostStreamRejectDetail,
  type PromptSession,
  type StreamHandle,
} from "./session.ts";
import { appendHostJournal, appendHostStreamRejected } from "./terminal-journal.node.ts";
import { attachHostAuxStreamContext, grokboxAuxFrom, type AuxParentBinding } from "./aux-request.ts";
import { hostAuxIntentFrom, type HostAuxIntent } from "./aux-purpose.ts";
import { emitHostActivity } from "./activity.ts";

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

function officialExecutor(original: unknown, state: unknown): HostPromptExecutor | undefined {
  if (!original || typeof original !== "object") return undefined;
  const session = original as { getExecutor?: (value?: unknown) => HostPromptExecutor };
  if (typeof session.getExecutor !== "function") return undefined;
  const executor = session.getExecutor(state);
  return executor && typeof executor.stream === "function" ? executor : undefined;
}

function overlayOfficialNoStepStreams(
  managed: HostPromptSession,
  original: unknown,
  onDecline: () => void,
  binding: Omit<AuxParentBinding, "stepId">,
): HostPromptSession {
  // Session-local, not a process-global latest STEP. A new main attempt invalidates
  // the prior parent immediately; only its successful Host response qualifies it.
  let attempt: object | undefined;
  let parent: AuxParentBinding | undefined;
  const capturedParents = new WeakMap<HostAuxIntent, { attempt: object | undefined; parent: AuxParentBinding | undefined }>();
  const overlay = (getManaged: (state?: unknown) => HostPromptExecutor) => (state?: unknown): HostPromptExecutor => {
    const managedEx = getManaged(state);
    const overlayEx: HostPromptExecutor = {
      appendMessages(messages) { managedEx.appendMessages(messages); return overlayEx; },
      getMessages: () => managedEx.getMessages(),
      getState: () => managedEx.getState(),
      clearMessages: () => managedEx.clearMessages(),
      stream(ctx, invocationId, tools, options) {
        const auxCall = hostAuxIntentFrom(options);
        if (auxCall) {
          const { intent } = auxCall;
          if (!capturedParents.has(intent)) capturedParents.set(intent, { attempt, parent });
          const captured = capturedParents.get(intent)!;
          const attached = intent.turnId === binding.turnId && intent.ctx === ctx && captured.attempt === attempt
            ? attachHostAuxStreamContext({ purpose: intent.purpose, auxRequestId: intent.auxRequestId, parent: captured.parent, ctx })
            : undefined;
          // A known aux call without a valid parent stays on the managed rejection
          // path, never the official no-STEP fallback. Do not mutate the Host ctx.
          if (!attached) return toHostStreamResult(visibleFailureHandle(binding.modelId, "invalid_envelope"));
          return managedEx.stream(attached.ctx, invocationId, tools, auxCall.options);
        }
        if (grokboxAuxFrom(ctx) ?? grokboxAuxFrom(options)) {
          return managedEx.stream(ctx, invocationId, tools, options);
        }
        if (!boundedId(invocationId)) {
          const official = officialExecutor(original, state);
          if (official) {
            onDecline();
            return official.stream(ctx, invocationId, tools, options);
          }
        }
        const current = {};
        attempt = current;
        parent = undefined;
        const stepId = boundedId(invocationId);
        const result = managedEx.stream(ctx, invocationId, tools, options);
        void result.response.then((response) => {
          if (attempt === current && stepId && !response.error
            && (response.finishReason === "stop" || response.finishReason === "tool-calls")) {
            parent = { ...binding, stepId };
          }
        }, () => { /* Rejection never qualifies a parent. */ });
        return result;
      },
    };
    return overlayEx;
  };
  return {
    getModelId: () => managed.getModelId(),
    getExecutor: overlay((state) => managed.getExecutor(state)),
    getExecutorWithoutResolvedModelTracking: overlay((state) => managed.getExecutorWithoutResolvedModelTracking(state)),
  };
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
    const captured = captureHostManagedSelection(input.durableRoot, agentId);
    if (captured.kind === "official") return args.originalSession;
    const modelId = captured.modelId;
    const record = captured.record;
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
        writeStage("stream_enter", "entered", {
          ...(stepId ? { stepId } : {}),
          ...(request?.aux ? { auxPurpose: request.aux.purpose, parentStepId: request.aux.parent.stepId } : {}),
        });
        return session.stream(request);
      },
    });
    if (!turnId) {
      writeStage("hook_decline", "compact_passthrough");
      return args.originalSession;
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
    const vision = record.capabilities.vision === true || record.capabilities.images === true
      || (record.dataTypes ?? []).includes("images");
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
      onFirstChunk: (stepId) => {
        writeStage("first_chunk", "ok", { stepId });
        emitHostActivity({ type: "thinking-delta", text: " " });
      },
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
    const managed = asHostPromptSession(wrapStream(session), modelId, onRequestId, {
      requireStepId: true, reject, contextWindowTokens: record.contextWindowTokens,
    });
    return overlayOfficialNoStepStreams(managed, args.originalSession, () => {
      writeStage("hook_decline", "compact_passthrough");
    }, { agentId, turnId, modelId, selectionRevision: captured.selectionRevision });
  };
}
