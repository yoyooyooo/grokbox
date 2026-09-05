import {
  appendTurnSeamTerminal,
  TURN_SEAM_BOUNDED_STRING,
  type TurnSeamAssignment,
  type TurnSeamOutcome,
  type TurnSeamTerminalClass,
  type TurnSeamWriteResult,
} from "./events.ts";
import {
  callStubModeld,
  isModeldFailure,
  STUB_ECHO_MODEL_ID,
  STUB_ECHO_PARTS,
  submitPartsFromResponse,
} from "./modeld-ipc.ts";
import {
  asHostPromptSession,
  createManagedPromptSession,
  type HostPromptSession,
  type PromptSession,
  type SessionTerminal,
  type StreamHandle,
  type StreamPart,
  type StreamRequest,
} from "./session.ts";

export type SeamMode = "observe" | "identity" | "route";

export type SeamEvidence = {
  emitted: boolean;
  gap: null | "write_failed" | "unprojected";
};

export type StubRouteSubmit = {
  invocationId: string;
  agentId: string;
  modelId: string;
  abortSignal?: AbortSignal;
};

export type StubRouteDriver = {
  dispatches: number;
  officialCalls: number;
  secondProviderCalls: number;
  parts: StreamPart[];
  submit?: (request: StubRouteSubmit) => Promise<{ parts: StreamPart[]; dispatched: boolean }>;
  disconnectInvocation?: (invocationId: string) => Promise<void>;
  resolveCredential: () => never;
  openNetwork: () => never;
};

function disabledCredential(): never {
  throw new Error("stub route driver has credential resolution disabled");
}

function disabledNetwork(): never {
  throw new Error("stub route driver has network disabled");
}

export function createStubRouteDriver(parts: StreamPart[]): StubRouteDriver {
  return {
    dispatches: 0,
    officialCalls: 0,
    secondProviderCalls: 0,
    parts,
    resolveCredential: disabledCredential,
    openNetwork: disabledNetwork,
  };
}

export function createModeldRouteDriver(runRoot: string): StubRouteDriver {
  const driver = createStubRouteDriver(STUB_ECHO_PARTS);
  driver.submit = async (request) => {
    if (request.abortSignal?.aborted) {
      return { parts: [{ type: "finish", reason: "abort" }], dispatched: false };
    }
    if (request.modelId !== STUB_ECHO_MODEL_ID) {
      throw new Error("stub route driver rejects non-stub models");
    }
    const response = await callStubModeld(runRoot, {
      method: "submit",
      invocationId: request.invocationId,
      agentId: request.agentId,
      modelId: request.modelId,
    });
    if (isModeldFailure(response)) throw new Error(`modeld ${response.code}`);
    return submitPartsFromResponse(response);
  };
  driver.disconnectInvocation = async (invocationId) => {
    try {
      await callStubModeld(runRoot, { method: "disconnect", invocationId });
    } catch {
      /* disconnect is best-effort */
    }
  };
  return driver;
}

export type SessionSeamConfig = {
  mode: SeamMode;
  root: string;
  assignment: TurnSeamAssignment;
  modelId?: string;
  now?: () => string;
  driver?: StubRouteDriver;
  writeTerminal?: (root: string, input: unknown) => Promise<TurnSeamWriteResult>;
};

type InvocationState = {
  session: HostPromptSession;
  dispatched: boolean;
  recorded: boolean;
  evidence: SeamEvidence;
  agentId: string;
  modelId: string;
  invocationId: string;
};

function invocationIdOf(sessionOptions: unknown): string | undefined {
  if (sessionOptions === null || typeof sessionOptions !== "object") return undefined;
  const value = (sessionOptions as { invocationId?: unknown }).invocationId;
  return typeof value === "string" ? value : undefined;
}

function agentIdOf(args: { agentId?: string; sessionOptions?: unknown }): string | undefined {
  if (typeof args.agentId === "string") return args.agentId;
  if (args.sessionOptions === null || typeof args.sessionOptions !== "object") return undefined;
  const value = (args.sessionOptions as { agentId?: unknown }).agentId;
  return typeof value === "string" ? value : undefined;
}

function idleStreamHandle(modelId: string): StreamHandle {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {},
    },
    response: Promise.resolve({ modelId, messages: [] }),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
  };
}

function boundedRouteModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > TURN_SEAM_BOUNDED_STRING) return null;
  if (/[\n\r]/.test(value)) return null;
  return value;
}

function boundedAdmissionId(value: unknown): string | null {
  return boundedRouteModelId(value);
}

function isOrdinaryMain(sessionOptions: unknown, agentId: string | undefined): boolean {
  if (sessionOptions !== null && typeof sessionOptions === "object") {
    const reason = (sessionOptions as { inferenceReason?: unknown }).inferenceReason;
    if (typeof reason === "string") return reason === "main";
  }
  return typeof agentId === "string" && agentId.length > 0;
}

function errorSession(modelId: string): HostPromptSession {
  return asHostPromptSession(
    createManagedPromptSession({
      modelId,
      vision: false,
      parallel: "allow",
      parts: [{ type: "finish", reason: "error" }],
    }),
    modelId,
  );
}

function abortHandle(modelId: string, onTerminal?: (terminal: SessionTerminal) => void): StreamHandle {
  return createManagedPromptSession({
    modelId,
    vision: false,
    parallel: "allow",
    parts: [{ type: "finish", reason: "abort" }],
    onTerminal,
  }).stream();
}

function handleFromParts(
  modelId: string,
  parts: StreamPart[],
  request: StreamRequest | undefined,
  onTerminal?: (terminal: SessionTerminal) => void,
): StreamHandle {
  return createManagedPromptSession({
    modelId,
    vision: false,
    parallel: "allow",
    parts,
    onTerminal,
  }).stream(request);
}

export function createSessionSeam(config: SessionSeamConfig) {
  if (config.mode === "route" && !config.driver) {
    throw new Error("route seam requires a stub driver");
  }
  if (config.mode === "route" && config.assignment === "official") {
    throw new Error("route seam does not admit assignment=official");
  }
  const routeModelId = config.mode === "route" ? boundedRouteModelId(config.modelId) : null;
  if (config.mode === "route" && routeModelId == null) {
    throw new Error("route seam requires a bounded modelId");
  }
  const invocations = new Map<string, InvocationState>();
  let writes = Promise.resolve();

  const enqueue = (work: () => Promise<void>): void => {
    writes = writes.then(work, work);
  };

  const writeTerminal = config.writeTerminal ?? appendTurnSeamTerminal;

  const record = (
    state: InvocationState,
    terminalClass: TurnSeamTerminalClass,
    toolCallCount: number,
    outcome: TurnSeamOutcome,
  ): void => {
    if (state.recorded) return;
    state.recorded = true;
    enqueue(async () => {
      try {
        const result = await writeTerminal(config.root, {
          name: "turn_seam_terminal",
          at: (config.now ?? (() => new Date().toISOString()))(),
          mode: "route",
          agentId: state.agentId,
          assignment: config.assignment,
          modelId: routeModelId,
          invocationId: state.invocationId,
          toolCallCount,
          terminalClass,
          outcome,
        });
        if (result === "written") {
          state.evidence = { emitted: true, gap: null };
          return;
        }
        state.evidence = { emitted: false, gap: result };
      } catch {
        state.evidence = { emitted: false, gap: "write_failed" };
      }
    });
  };

  const hook = (args: {
    originalSession: unknown;
    sessionOptions?: unknown;
    agentId?: string;
  }): unknown => {
    if (config.mode !== "route" || routeModelId == null) return args.originalSession;
    const modelId = routeModelId;
    const agentIdRaw = agentIdOf(args);
    if (!isOrdinaryMain(args.sessionOptions, agentIdRaw)) return args.originalSession;
    const invocationId = boundedAdmissionId(invocationIdOf(args.sessionOptions));
    const agentId = boundedAdmissionId(agentIdRaw);
    if (invocationId == null || agentId == null) {
      return errorSession(modelId);
    }
    const existing = invocations.get(invocationId);
    if (existing) {
      if (existing.agentId !== agentId || existing.modelId !== modelId) {
        return errorSession(modelId);
      }
      return existing.session;
    }
    const driver = config.driver!;

    const onTerminal = (terminal: SessionTerminal): void => {
      const current = invocations.get(invocationId);
      if (!current) return;
      record(current, terminal.terminalClass, terminal.toolCallCount, "managed");
    };

    const inner = createManagedPromptSession({
      modelId,
      vision: false,
      parallel: "allow",
      parts: driver.parts,
      onTerminal,
    });

    let state: InvocationState;
    const prompt: PromptSession = {
      stream(request) {
        if (state.dispatched) return idleStreamHandle(modelId);
        if (request?.abortSignal?.aborted) {
          state.dispatched = true;
          return abortHandle(modelId, onTerminal);
        }
        state.dispatched = true;
        if (driver.submit) {
          const loaded = driver
            .submit({
              invocationId,
              agentId,
              modelId,
              abortSignal: request?.abortSignal,
            })
            .then((result) => {
              driver.dispatches += result.dispatched ? 1 : 0;
              return handleFromParts(modelId, result.parts, request, onTerminal);
            })
            .catch(() => {
              driver.dispatches += 1;
              return handleFromParts(modelId, [{ type: "finish", reason: "error" }], request, onTerminal);
            });
          return {
            fullStream: {
              async *[Symbol.asyncIterator]() {
                yield* (await loaded).fullStream;
              },
            },
            response: loaded.then(async (handle) => await handle.response),
            usage: loaded.then(async (handle) => await handle.usage),
          };
        }
        driver.dispatches += 1;
        return inner.stream(request);
      },
    };

    state = {
      session: asHostPromptSession(prompt, modelId),
      dispatched: false,
      recorded: false,
      evidence: { emitted: false, gap: null },
      agentId,
      modelId,
      invocationId,
    };
    invocations.set(invocationId, state);
    return state.session;
  };

  return {
    hook,
    async disconnect(invocationId: string): Promise<void> {
      const state = invocations.get(invocationId);
      if (!state) return;
      if (config.driver?.disconnectInvocation) {
        try {
          await config.driver.disconnectInvocation(invocationId);
        } catch {
          /* modeld disconnect is best-effort */
        }
      }
      record(state, "unknown", 0, "managed");
      await writes;
    },
    evidence(invocationId: string): SeamEvidence | undefined {
      return invocations.get(invocationId)?.evidence;
    },
    async flush(): Promise<void> {
      await writes;
    },
  };
}

export function bindHostSessionHook(input: {
  mode: SeamMode;
  durableRoot: string;
  runRoot: string;
}): (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string }) => unknown {
  if (input.mode !== "route") {
    return (args) => args.originalSession;
  }
  const driver = createModeldRouteDriver(input.runRoot);
  const seam = createSessionSeam({
    mode: "route",
    root: input.durableRoot,
    assignment: "main",
    modelId: STUB_ECHO_MODEL_ID,
    driver,
  });
  return (args) => seam.hook(args);
}
