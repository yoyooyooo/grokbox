import { lstatSync } from "node:fs";
import { appendSeamRouteEvent, TURN_SEAM_BOUNDED_STRING, type HostStreamRejectReason, type ModelStepAdmission,
  type ModelStepStage, type TurnSeamAssignment, type TurnSeamOutcome, type TurnSeamTerminalClass,
  type TurnSeamWriteResult } from "./events.ts";
import { callStubModeld, isModeldFailure, modeldHandshake, modeldSocketPath, MODELD_SUBMIT_TIMEOUT_MS, STUB_ECHO_PARTS, submitPartsFromResponse } from "./modeld-ipc.ts";
import { decideRouteSession, loadModelsFileSync } from "./models.ts";
import { parseHostBinding, type HostBinding } from "./modeld-binding.ts";
import { buildModelEnvelope, type ModelEnvelope } from "./envelope.ts";
import { sha256Text } from "./hash.ts";
import { combineAbortSignals } from "./abort-signals.ts";
import { asHostPromptSession, createStreamingPromptSession, visibleFailureHandle, VisibleStreamError,
  type HostPromptSession, type PromptSession, type StreamHandle, type StreamPart, type VisibleFailureContext,
  type VisibleFailureStage } from "./session.ts";

export type SeamMode = "observe" | "identity" | "route";
export type SeamEvidence = { emitted: boolean; gap: null | "write_failed" | "unprojected" };
export type StubRouteSubmit = {
  invocationId: string;
  turnId: string;
  agentId: string;
  modelId: string;
  envelope: ModelEnvelope;
  abortSignal?: AbortSignal;
};
export type StubRouteDriver = {
  dispatches: number; officialCalls: number; secondProviderCalls: number;
  parts: StreamPart[];
  delivery: "response-only" | "stream";
  vision?: boolean;
  parallel?: "allow" | "fail-closed";
  stream?: (request: StubRouteSubmit) => AsyncIterable<StreamPart> | Promise<AsyncIterable<StreamPart>>;
  submit?: (request: StubRouteSubmit) => Promise<{ parts: StreamPart[]; dispatched: boolean; assignment?: "main" | "agent"; modelId?: string }>;
  disconnectInvocation?: (invocationId: string) => Promise<void>;
  resolveCredential: () => never; openNetwork: () => never;
};
function disabledCredential(): never { throw new Error("stub route driver has credential resolution disabled"); }
function disabledNetwork(): never { throw new Error("stub route driver has network disabled"); }
export function createStubRouteDriver(parts: StreamPart[]): StubRouteDriver {
  return { dispatches: 0, officialCalls: 0, secondProviderCalls: 0, parts,
    delivery: parts.some((part) => part.type === "tool-call") ? "stream" : "response-only",
    resolveCredential: disabledCredential, openNetwork: disabledNetwork };
}
export function createModeldRouteDriver(runRoot: string, binding?: HostBinding): StubRouteDriver {
  const driver = createStubRouteDriver(STUB_ECHO_PARTS);
  const host = binding ? parseHostBinding(binding) : undefined;
  const invocations = new Map<string, { generation: Promise<string>; unknown: boolean }>();
  const entryFor = (id: string, signal?: AbortSignal) => {
    const old = invocations.get(id);
    if (old) return old;
    if (!host || invocations.size >= 1024) throw new VisibleStreamError("admit", "model_error", "modeld binding unavailable");
    // A new invocation may handshake after restart. The SAME invocation never refreshes its fence or retries uncertainty.
    const entry = { generation: modeldHandshake(runRoot, signal), unknown: false };
    invocations.set(id, entry); return entry;
  };
  driver.submit = async (request) => {
    if (request.abortSignal?.aborted) return { parts: [{ type: "finish", reason: "abort" }], dispatched: false };
    if (!request.modelId) throw new VisibleStreamError("admit", "model_error", "route driver requires a modelId");
    let entry: { generation: Promise<string>; unknown: boolean };
    try { entry = entryFor(request.invocationId, request.abortSignal); }
    catch (error) {
      if (error instanceof VisibleStreamError) throw error;
      throw new VisibleStreamError("admit", "model_error", "modeld binding unavailable");
    }
    if (entry.unknown) throw new VisibleStreamError("admit", "model_error", "modeld invocation unknown");
    try {
      const serverGeneration = await entry.generation;
      if (entry.unknown) throw new VisibleStreamError("admit", "model_error", "modeld invocation unknown");
      const response = await callStubModeld(runRoot, { method: "submit", serverGeneration, host,
        invocationId: request.invocationId, turnId: request.turnId, agentId: request.agentId, envelope: request.envelope }, MODELD_SUBMIT_TIMEOUT_MS, request.abortSignal);
      if (isModeldFailure(response)) {
        throw new VisibleStreamError(response.code === "driver-failed" ? "provider" : "admit", "model_error", "modeld admission failed");
      }
      try {
        const result = submitPartsFromResponse(response);
        if (result.modelId !== request.modelId) {
          throw new VisibleStreamError("normalize", "model_error", "modeld malformed output");
        }
        return result;
      }
      catch (error) {
        if (error instanceof VisibleStreamError) throw error;
        throw new VisibleStreamError("normalize", "model_error", "modeld malformed output");
      }
    } catch (error) {
      entry.unknown = true;
      if (error instanceof VisibleStreamError) throw error;
      throw new VisibleStreamError("admit", "model_error", "modeld request failed without retry");
    }
  };
  driver.disconnectInvocation = async (invocationId) => {
    try {
      const entry = entryFor(invocationId); entry.unknown = true;
      await callStubModeld(runRoot, { method: "disconnect", serverGeneration: await entry.generation, host, invocationId });
    } catch { /* Disconnect is best-effort, never a retry or fallback. */ }
  };
  return driver;
}
export const UNBOUND_HOST_GENERATION = "unbound";
const STEP_SLOT_LIMIT = 1024;
export type SessionSeamConfig = {
  mode: SeamMode; root: string; assignment: TurnSeamAssignment; modelId?: string;
  /** Route only. Resolve per-agent at session create. `assignment: "official"` returns originalSession (passthrough). */
  resolveSession?: (agentId: string) => { modelId: string; assignment?: TurnSeamAssignment };
  /** Sync pre-dispatch probe. True → return originalSession (no wrap). */
  preflightOfficial?: () => boolean;
  now?: () => string; driver?: StubRouteDriver; hostGenerationId?: string;
  writeTerminal?: (root: string, input: unknown) => Promise<TurnSeamWriteResult>;
};
type SessionRow = {
  session: HostPromptSession; turnId: string; agentId: string; modelId: string; disconnected: boolean;
};
type StepSlot = {
  stepId: string; turnId: string; agentId: string; hostGenerationId: string; modelId: string;
  dispatched: boolean; recorded: boolean; disconnected: boolean;
  evidence: SeamEvidence; requestHash?: string; cancel?: () => void;
  toolCallCount: number; assignment: TurnSeamAssignment; admission: ModelStepAdmission;
  failureStage?: VisibleFailureStage;
};
function invocationIdOf(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const id = (options as { invocationId?: unknown }).invocationId;
  return typeof id === "string" ? id : undefined;
}
function agentIdOf(args: { agentId?: string; sessionOptions?: unknown }): string | undefined {
  if (typeof args.agentId === "string") return args.agentId;
  if (!args.sessionOptions || typeof args.sessionOptions !== "object") return undefined;
  const id = (args.sessionOptions as { agentId?: unknown }).agentId;
  return typeof id === "string" ? id : undefined;
}
function emptyFullStream(): AsyncIterable<StreamPart> { return { async *[Symbol.asyncIterator]() {} }; }
function deliveryHandle(handle: StreamHandle, responseOnly: boolean): StreamHandle {
  // Production stub IPC is still one buffered response. Do not market it as token streaming.
  return responseOnly ? { ...handle, fullStream: emptyFullStream() } : handle;
}
function idleStreamHandle(modelId: string): StreamHandle {
  return { fullStream: emptyFullStream(), response: Promise.resolve({ modelId, messages: [{ role: "assistant", content: "" }] }),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }) };
}
function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= TURN_SEAM_BOUNDED_STRING && !/[\x00-\x1f]/.test(value) ? value : null;
}
function isOrdinaryMain(options: unknown, agentId: string | undefined): boolean {
  if (options && typeof options === "object") {
    const reason = (options as { inferenceReason?: unknown }).inferenceReason;
    if (typeof reason === "string") return reason === "main";
  }
  return typeof agentId === "string" && agentId.length > 0;
}
function errorSession(modelId: string, ctx?: VisibleFailureContext): HostPromptSession {
  return asHostPromptSession({
    stream: (request) => deliveryHandle(visibleFailureHandle(modelId, "invalid_envelope", undefined, undefined, {
      ...ctx,
      invocationId: ctx?.invocationId ?? (typeof request?.invocationId === "string" ? request.invocationId : undefined),
      stage: ctx?.stage ?? "admit",
    }), true),
  }, modelId);
}
function modeldSocketMissing(runRoot: string): boolean {
  try { return !lstatSync(modeldSocketPath(runRoot)).isSocket(); }
  catch { return true; }
}
function fromParts(parts: StreamPart[]): AsyncIterable<StreamPart> {
  return { async *[Symbol.asyncIterator]() { for (const part of parts) yield part; } };
}

function stageForError(code: string): ModelStepStage {
  if (code === "invalid_tools" || code === "parallel_tools") return "tools";
  if (code === "unsupported_options") return "options";
  if (code === "unsupported_content" || code === "invalid_envelope" || code === "envelope_too_large" || code === "unsupported_image") return "message-shape";
  return "internal";
}

export function createSessionSeam(config: SessionSeamConfig) {
  if (config.mode === "route" && !config.driver) throw new Error("route seam requires a stub driver");
  if (config.mode === "route" && config.assignment === "official") throw new Error("route seam does not admit assignment=official");
  const staticRouteModelId = config.mode === "route" ? boundedId(config.modelId) : null;
  if (config.mode === "route" && !config.resolveSession && staticRouteModelId == null) throw new Error("route seam requires a bounded modelId");
  const resolveHookModel = (agentId: string): { modelId: string; assignment: TurnSeamAssignment } | null => {
    if (config.resolveSession) {
      try {
        const next = config.resolveSession(agentId);
        if (next.assignment === "official") return { modelId: "official", assignment: "official" };
        const modelId = boundedId(next.modelId);
        if (!modelId) return null;
        return { modelId, assignment: next.assignment ?? config.assignment };
      } catch { return null; }
    }
    if (staticRouteModelId == null) return null;
    return { modelId: staticRouteModelId, assignment: config.assignment };
  };
  const hostGenerationId = config.hostGenerationId == null ? UNBOUND_HOST_GENERATION : boundedId(config.hostGenerationId);
  if (hostGenerationId == null) throw new Error("route seam requires a bounded hostGenerationId");
  const sessions = new Map<string, SessionRow>();
  const steps = new Map<string, StepSlot>();
  const streamRejects = new Set<string>();
  let writes = Promise.resolve();
  const writeEvent = config.writeTerminal ?? appendSeamRouteEvent;
  const sessionKey = (turnId: string) => `${hostGenerationId}:${turnId}`;
  const stepKey = (stepId: string) => `${hostGenerationId}:${stepId}`;
  const enqueue = (slot: StepSlot | { evidence: SeamEvidence }, input: unknown) => {
    const work = async () => {
      try {
        const result = await writeEvent(config.root, input);
        slot.evidence = result === "written" ? { emitted: true, gap: null } : { emitted: false, gap: result };
      } catch { slot.evidence = { emitted: false, gap: "write_failed" }; }
    };
    writes = writes.then(work, work);
  };
  const recordStep = (slot: StepSlot, terminalClass: TurnSeamTerminalClass, toolCallCount: number, outcome: TurnSeamOutcome,
    stage: ModelStepStage, errorCode?: string) => {
    if (slot.recorded) return;
    slot.recorded = true;
    enqueue(slot, {
      name: "model_step_terminal", schemaVersion: 2, at: (config.now ?? (() => new Date().toISOString()))(),
      mode: "route", hostGenerationId: slot.hostGenerationId, agentId: slot.agentId, turnId: slot.turnId,
      invocationId: slot.stepId, modelId: slot.modelId, assignment: slot.assignment, terminalClass, outcome,
      toolCallCount, stage, admission: slot.admission, ...(errorCode ? { errorCode } : {}),
    });
  };
  const recordStreamRejected = (row: SessionRow, reason: HostStreamRejectReason) => {
    const key = `${hostGenerationId}:${row.agentId}:${row.turnId}:${reason}`;
    if (streamRejects.has(key)) return;
    streamRejects.add(key);
    const evidence = { evidence: { emitted: false, gap: null } as SeamEvidence };
    enqueue(evidence, {
      name: "host_stream_rejected", schemaVersion: 2, at: (config.now ?? (() => new Date().toISOString()))(),
      mode: "route", hostGenerationId, agentId: row.agentId, turnId: row.turnId, stage: "stream-id",
      errorCode: "invalid_envelope", reason,
    });
  };
  const occupy = (stepId: string, turnId: string, agentId: string, session: { modelId: string; assignment: TurnSeamAssignment }): StepSlot | "conflict" | "capacity" => {
    const existing = steps.get(stepKey(stepId));
    if (existing) return existing.turnId === turnId && existing.agentId === agentId ? existing : "conflict";
    if (steps.size >= STEP_SLOT_LIMIT) return "capacity";
    const slot: StepSlot = {
      stepId, turnId, agentId, hostGenerationId, modelId: session.modelId, dispatched: false, recorded: false, disconnected: false,
      evidence: { emitted: false, gap: null }, toolCallCount: 0, assignment: session.assignment, admission: "none",
    };
    steps.set(stepKey(stepId), slot);
    return slot;
  };
  const hook = (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string; onRequestId?: (id: string) => void }): unknown => {
    if (config.mode !== "route") return args.originalSession;
    const agentRaw = agentIdOf(args);
    if (!isOrdinaryMain(args.sessionOptions, agentRaw)) return args.originalSession;
    const turnId = boundedId(invocationIdOf(args.sessionOptions));
    const agentId = boundedId(agentRaw);
    // Pre-dispatch local failures: Host can still take originalSession (no tool side effects).
    if (!agentId) return args.originalSession;
    const resolved = resolveHookModel(agentId);
    if (!resolved) return args.originalSession;
    if (resolved.assignment === "official") return args.originalSession;
    if (!turnId) return args.originalSession;
    try { if (config.preflightOfficial?.() === true) return args.originalSession; }
    catch { return args.originalSession; }
    const { modelId } = resolved;
    const existingSession = sessions.get(sessionKey(turnId));
    if (existingSession) {
      return existingSession.agentId === agentId && existingSession.modelId === modelId
        ? existingSession.session
        : errorSession(modelId, { agentId, invocationId: turnId, stage: "admit" });
    }
    const driver = config.driver!;
    const row: SessionRow = { session: undefined as unknown as HostPromptSession, turnId, agentId, modelId, disconnected: false };
    const prompt: PromptSession = { stream(request = {}) {
      if (row.disconnected) return idleStreamHandle(modelId);
      if (request.invocationId === undefined) {
        recordStreamRejected(row, "missing-step-id");
        return deliveryHandle(visibleFailureHandle(modelId, "invalid_envelope", undefined, undefined, { agentId, stage: "admit" }), driver.delivery === "response-only");
      }
      const stepId = boundedId(request.invocationId);
      if (!stepId) {
        recordStreamRejected(row, "invalid-step-id");
        return deliveryHandle(visibleFailureHandle(modelId, "invalid_envelope", undefined, undefined, { agentId, stage: "admit" }), driver.delivery === "response-only");
      }
      const slotOr = occupy(stepId, turnId, agentId, resolved);
      if (slotOr === "capacity" || slotOr === "conflict") {
        return deliveryHandle(visibleFailureHandle(modelId, "invocation_conflict", undefined, undefined, { agentId, invocationId: stepId, stage: "admit" }), driver.delivery === "response-only");
      }
      const slot = slotOr;
      const envelope = request.envelope ?? buildModelEnvelope(request.messages ?? []);
      const hash = sha256Text(JSON.stringify(envelope));
      if (slot.dispatched) {
        return slot.requestHash === hash || request.abortSignal?.aborted
          ? idleStreamHandle(modelId)
          : visibleFailureHandle(modelId, "invocation_conflict", undefined, undefined, { agentId, invocationId: stepId, stage: "admit" });
      }
      slot.dispatched = true;
      slot.requestHash = hash;
      const streaming = createStreamingPromptSession({
        modelId, vision: driver.vision === true, parallel: driver.parallel ?? "allow",
        usage: driver.stream ? undefined : { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        agentId, invocationId: stepId,
        visibleStage: (code) => (code === "invalid_stream" || code === "stream_limit") ? "normalize" : (slot.failureStage ?? "admit"),
        onToolCall: () => { slot.toolCallCount += 1; },
        onTerminal: (terminal) => {
          slot.cancel = undefined;
          const duplicate = slot.admission === "duplicate";
          const terminalClass = duplicate ? "unknown" : terminal.terminalClass;
          const outcome = terminal.rejected || duplicate ? "rejected" : "managed";
          const stage: ModelStepStage = slot.disconnected ? "disconnect" : duplicate ? "admission"
            : terminalClass === "abort" ? "abort"
            : terminal.stage ?? (terminal.rejected ? stageForError(terminal.errorCode ?? "") : "host-normalize");
          recordStep(slot, terminalClass, duplicate ? 0 : terminal.toolCallCount, outcome, stage, terminal.errorCode);
        },
        produce: async (produced) => {
          const submit: StubRouteSubmit = {
            invocationId: stepId, turnId, agentId, modelId, envelope: produced.envelope, abortSignal: produced.abortSignal,
          };
          if (driver.stream) {
            driver.dispatches += 1;
            slot.failureStage = "provider";
            return await driver.stream(submit);
          }
          if (driver.submit) {
            try {
              const result = await driver.submit(submit);
              if (typeof result.modelId === "string" && result.modelId !== modelId) {
                throw new VisibleStreamError("normalize", "model_error", "modeld malformed output");
              }
              if (result.assignment) slot.assignment = result.assignment;
              if (!result.dispatched) {
                slot.admission = "duplicate";
                return fromParts([{ type: "finish", reason: "error" }]);
              }
              slot.admission = "new";
              slot.failureStage = "normalize";
              driver.dispatches += 1;
              return fromParts(result.parts);
            } catch (error) {
              slot.admission = "unknown";
              if (error instanceof VisibleStreamError) { slot.failureStage = error.stage; throw error; }
              slot.failureStage = "admit";
              throw new VisibleStreamError("admit", "model_error", "modeld submit failed");
            }
          }
          driver.dispatches += 1;
          slot.failureStage = "normalize";
          return fromParts(driver.parts);
        },
      });
      const controller = new AbortController();
      slot.cancel = () => controller.abort();
      const cancellation = combineAbortSignals(request.abortSignal ? [request.abortSignal, controller.signal] : [controller.signal]);
      const handle = streaming.stream({ ...request, envelope, abortSignal: cancellation.signal });
      void handle.response.then(cancellation.dispose, cancellation.dispose);
      return deliveryHandle(handle, driver.delivery === "response-only");
    } };
    row.session = asHostPromptSession(prompt, modelId, args.onRequestId, {
      invocationId: turnId,
      requireStepId: true,
      reject: (code, detail) => {
        if (row.disconnected) return idleStreamHandle(modelId);
        const ctx = (invocationId?: string): VisibleFailureContext => ({
          agentId, ...(invocationId ? { invocationId } : {}), stage: "admit",
        });
        if (detail?.reason === "missing-step-id" || detail?.reason === "invalid-step-id") {
          recordStreamRejected(row, detail.reason);
          return deliveryHandle(visibleFailureHandle(modelId, code, undefined, undefined, ctx()), driver.delivery === "response-only");
        }
        const stepId = boundedId(detail?.invocationId);
        if (!stepId) {
          recordStreamRejected(row, "invalid-step-id");
          return deliveryHandle(visibleFailureHandle(modelId, code, undefined, undefined, ctx()), driver.delivery === "response-only");
        }
        const slotOr = occupy(stepId, turnId, agentId, resolved);
        if (slotOr === "capacity" || slotOr === "conflict") {
          return deliveryHandle(visibleFailureHandle(modelId, "invocation_conflict", undefined, undefined, ctx(stepId)), driver.delivery === "response-only");
        }
        const slot = slotOr;
        if (slot.dispatched) return idleStreamHandle(modelId);
        slot.dispatched = true;
        slot.failureStage = "admit";
        return deliveryHandle(visibleFailureHandle(modelId, code, undefined, (terminal) => {
          recordStep(slot, "error", 0, "rejected", terminal.stage ?? stageForError(terminal.errorCode ?? code), terminal.errorCode ?? code);
        }, ctx(stepId)), driver.delivery === "response-only");
      },
    });
    sessions.set(sessionKey(turnId), row);
    return row.session;
  };
  const disconnectSlot = (slot: StepSlot) => {
    if (slot.disconnected) return;
    slot.disconnected = true;
    recordStep(slot, "unknown", slot.toolCallCount, "managed", "disconnect");
    slot.cancel?.();
    try { void config.driver?.disconnectInvocation?.(slot.stepId); } catch { /* never retry */ }
  };
  return {
    hook,
    async disconnect(id: string): Promise<void> {
      const session = sessions.get(sessionKey(id));
      if (session) {
        session.disconnected = true;
        for (const slot of steps.values()) {
          if (slot.turnId === session.turnId && slot.agentId === session.agentId) disconnectSlot(slot);
        }
        await writes;
        return;
      }
      const slot = steps.get(stepKey(id));
      if (slot) disconnectSlot(slot);
      await writes;
    },
    evidence: (id: string) => steps.get(stepKey(id))?.evidence,
    async flush(): Promise<void> { await writes; },
  };
}

export function bindHostSessionHook(input: { mode: SeamMode; durableRoot: string; runRoot: string; binding?: HostBinding }):
  (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string }) => unknown {
  if (input.mode !== "route") return (args) => args.originalSession;
  const seam = createSessionSeam({
    mode: "route", root: input.durableRoot, assignment: "main",
    hostGenerationId: input.binding?.generationId,
    driver: createModeldRouteDriver(input.runRoot, input.binding),
    preflightOfficial: () => modeldSocketMissing(input.runRoot),
    resolveSession: (agentId) => {
      const file = loadModelsFileSync(input.durableRoot);
      if (!file) throw new Error("models unavailable");
      const decided = decideRouteSession(file, agentId);
      if (decided.kind === "official") return { modelId: "official", assignment: "official" };
      return { modelId: decided.modelId, assignment: decided.assignment };
    },
  });
  return (args) => seam.hook(args);
}
