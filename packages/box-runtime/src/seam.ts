import { appendTurnSeamTerminal, TURN_SEAM_BOUNDED_STRING, type TurnSeamAssignment,
  type TurnSeamOutcome, type TurnSeamTerminalClass, type TurnSeamWriteResult } from "./events.ts";
import { callStubModeld, isModeldFailure, modeldHandshake, STUB_ECHO_MODEL_ID, STUB_ECHO_PARTS, submitPartsFromResponse } from "./modeld-ipc.ts";
import { parseHostBinding, type HostBinding } from "./modeld-binding.ts";
import { buildModelEnvelope, type ModelEnvelope } from "./envelope.ts";
import { sha256Text } from "./hash.ts";
import { combineAbortSignals } from "./abort-signals.ts";
import { asHostPromptSession, createStreamingPromptSession, visibleFailureHandle,
  type HostPromptSession, type PromptSession, type StreamHandle, type StreamPart } from "./session.ts";

export type SeamMode = "observe" | "identity" | "route";
export type SeamEvidence = { emitted: boolean; gap: null | "write_failed" | "unprojected" };
export type StubRouteSubmit = { invocationId: string; agentId: string; modelId: string; envelope: ModelEnvelope; abortSignal?: AbortSignal };
export type StubRouteDriver = {
  dispatches: number; officialCalls: number; secondProviderCalls: number;
  parts: StreamPart[];
  delivery: "response-only" | "stream";
  vision?: boolean;
  parallel?: "allow" | "fail-closed";
  stream?: (request: StubRouteSubmit) => AsyncIterable<StreamPart> | Promise<AsyncIterable<StreamPart>>;
  submit?: (request: StubRouteSubmit) => Promise<{ parts: StreamPart[]; dispatched: boolean; assignment?: "main" | "agent" }>;
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
    if (!host || invocations.size >= 1024) throw new Error("modeld binding unavailable");
    // A new invocation may handshake after restart. The SAME invocation never refreshes its fence or retries uncertainty.
    const entry = { generation: modeldHandshake(runRoot, signal), unknown: false };
    invocations.set(id, entry); return entry;
  };
  driver.submit = async (request) => {
    if (request.abortSignal?.aborted) return { parts: [{ type: "finish", reason: "abort" }], dispatched: false };
    if (request.modelId !== STUB_ECHO_MODEL_ID) throw new Error("stub route driver rejects non-stub models");
    const entry = entryFor(request.invocationId, request.abortSignal);
    if (entry.unknown) throw new Error("modeld invocation unknown");
    try {
      const serverGeneration = await entry.generation;
      if (entry.unknown) throw new Error("modeld invocation unknown");
      const response = await callStubModeld(runRoot, { method: "submit", serverGeneration, host,
        invocationId: request.invocationId, turnId: request.invocationId, agentId: request.agentId, envelope: request.envelope }, 1000, request.abortSignal);
      if (isModeldFailure(response)) throw new Error("modeld admission failed");
      return submitPartsFromResponse(response);
    } catch { entry.unknown = true; throw new Error("modeld request failed without retry"); }
  };
  driver.disconnectInvocation = async (invocationId) => {
    try {
      const entry = entryFor(invocationId); entry.unknown = true;
      await callStubModeld(runRoot, { method: "disconnect", serverGeneration: await entry.generation, host, invocationId });
    } catch { /* Disconnect is best-effort, never a retry or fallback. */ }
  };
  return driver;
}
export type SessionSeamConfig = {
  mode: SeamMode; root: string; assignment: TurnSeamAssignment; modelId?: string;
  now?: () => string; driver?: StubRouteDriver;
  writeTerminal?: (root: string, input: unknown) => Promise<TurnSeamWriteResult>;
};
type InvocationState = {
  session: HostPromptSession; dispatched: boolean; recorded: boolean; disconnected: boolean;
  evidence: SeamEvidence; agentId: string; modelId: string; invocationId: string;
  requestHash?: string; cancel?: () => void; toolCallCount: number; assignment: TurnSeamAssignment;
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
function errorSession(modelId: string): HostPromptSession {
  return asHostPromptSession({ stream: () => deliveryHandle(visibleFailureHandle(modelId, "invalid_envelope"), true) }, modelId);
}
function fromParts(parts: StreamPart[]): AsyncIterable<StreamPart> {
  return { async *[Symbol.asyncIterator]() { for (const part of parts) yield part; } };
}

export function createSessionSeam(config: SessionSeamConfig) {
  if (config.mode === "route" && !config.driver) throw new Error("route seam requires a stub driver");
  if (config.mode === "route" && config.assignment === "official") throw new Error("route seam does not admit assignment=official");
  const routeModelId = config.mode === "route" ? boundedId(config.modelId) : null;
  if (config.mode === "route" && routeModelId == null) throw new Error("route seam requires a bounded modelId");
  const invocations = new Map<string, InvocationState>();
  let writes = Promise.resolve();
  const writeTerminal = config.writeTerminal ?? appendTurnSeamTerminal;
  const record = (state: InvocationState, terminalClass: TurnSeamTerminalClass, toolCallCount: number, outcome: TurnSeamOutcome) => {
    if (state.recorded) return;
    state.recorded = true;
    const work = async () => {
      try {
        const result = await writeTerminal(config.root, { name: "turn_seam_terminal", at: (config.now ?? (() => new Date().toISOString()))(),
          mode: "route", agentId: state.agentId, assignment: state.assignment, modelId: routeModelId,
          invocationId: state.invocationId, toolCallCount, terminalClass, outcome });
        state.evidence = result === "written" ? { emitted: true, gap: null } : { emitted: false, gap: result };
      } catch { state.evidence = { emitted: false, gap: "write_failed" }; }
    };
    writes = writes.then(work, work);
  };
  const hook = (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string; onRequestId?: (id: string) => void }): unknown => {
    if (config.mode !== "route" || routeModelId == null) return args.originalSession;
    const modelId = routeModelId;
    const agentRaw = agentIdOf(args);
    if (!isOrdinaryMain(args.sessionOptions, agentRaw)) return args.originalSession;
    const invocationId = boundedId(invocationIdOf(args.sessionOptions));
    const agentId = boundedId(agentRaw);
    if (!invocationId || !agentId) return errorSession(modelId);
    const existing = invocations.get(invocationId);
    if (existing) return existing.agentId === agentId && existing.modelId === modelId ? existing.session : errorSession(modelId);
    const driver = config.driver!;
    let state: InvocationState;
    const streaming = createStreamingPromptSession({ modelId, vision: driver.vision === true, parallel: driver.parallel ?? "allow",
      usage: driver.stream ? undefined : { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      onToolCall: () => { state.toolCallCount += 1; },
      onTerminal: (terminal) => {
        state.cancel = undefined;
        record(state, terminal.terminalClass, terminal.toolCallCount, terminal.rejected ? "rejected" : "managed");
      },
      produce: async (request) => {
        const submit: StubRouteSubmit = { invocationId, agentId, modelId, envelope: request.envelope, abortSignal: request.abortSignal };
        if (driver.stream) { driver.dispatches += 1; return await driver.stream(submit); }
        if (driver.submit) {
          try {
            const result = await driver.submit(submit);
            driver.dispatches += result.dispatched ? 1 : 0;
            if (result.assignment) state.assignment = result.assignment;
            return fromParts(result.parts);
          } catch { throw new Error("modeld submit failed"); }
        }
        driver.dispatches += 1;
        return fromParts(driver.parts);
      },
    });
    const prompt: PromptSession = { stream(request = {}) {
      if (state.disconnected) return idleStreamHandle(modelId);
      const envelope = request.envelope ?? buildModelEnvelope(request.messages ?? []);
      const hash = sha256Text(JSON.stringify(envelope));
      if (state.dispatched) return state.requestHash === hash || request.abortSignal?.aborted
        ? idleStreamHandle(modelId) : visibleFailureHandle(modelId, "invocation_conflict");
      state.dispatched = true;
      state.requestHash = hash;
      const controller = new AbortController();
      state.cancel = () => controller.abort();
      const cancellation = combineAbortSignals(request.abortSignal ? [request.abortSignal, controller.signal] : [controller.signal]);
      const handle = streaming.stream({ ...request, envelope, abortSignal: cancellation.signal });
      void handle.response.then(cancellation.dispose, cancellation.dispose);
      return deliveryHandle(handle, driver.delivery === "response-only");
    } };
    state = {
      session: asHostPromptSession(prompt, modelId, args.onRequestId, { invocationId, reject: (code) => {
        if (state.dispatched || state.disconnected) return idleStreamHandle(modelId);
        state.dispatched = true;
        return deliveryHandle(visibleFailureHandle(modelId, code, undefined, (terminal) => record(state, terminal.terminalClass, 0, "rejected")), driver.delivery === "response-only");
      } }),
      dispatched: false, recorded: false, disconnected: false, evidence: { emitted: false, gap: null }, agentId, modelId, invocationId, toolCallCount: 0, assignment: config.assignment,
    };
    invocations.set(invocationId, state);
    return state.session;
  };
  return {
    hook,
    async disconnect(invocationId: string): Promise<void> {
      const state = invocations.get(invocationId);
      if (!state) return;
      state.disconnected = true;
      record(state, "unknown", state.toolCallCount, "managed");
      state.cancel?.();
      try { await config.driver?.disconnectInvocation?.(invocationId); } catch { /* never retry */ }
      await writes;
    },
    evidence: (invocationId: string) => invocations.get(invocationId)?.evidence,
    async flush(): Promise<void> { await writes; },
  };
}

export function bindHostSessionHook(input: { mode: SeamMode; durableRoot: string; runRoot: string; binding?: HostBinding }):
  (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string }) => unknown {
  if (input.mode !== "route") return (args) => args.originalSession;
  const seam = createSessionSeam({ mode: "route", root: input.durableRoot, assignment: "main", modelId: STUB_ECHO_MODEL_ID,
    driver: createModeldRouteDriver(input.runRoot, input.binding) });
  return (args) => seam.hook(args);
}
