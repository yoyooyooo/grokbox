import {
  appendTurnSeamTerminal,
  type TurnSeamAssignment,
  type TurnSeamOutcome,
  type TurnSeamTerminalClass,
  type TurnSeamWriteResult,
} from "./events.ts";
import {
  createManagedPromptSession,
  type PromptSession,
  type SessionTerminal,
  type StreamPart,
} from "./session.ts";

export type SeamMode = "observe" | "identity" | "route";

export type SeamEvidence = {
  emitted: boolean;
  gap: null | "write_failed" | "unprojected";
};

export type StubRouteDriver = {
  dispatches: number;
  officialCalls: number;
  secondProviderCalls: number;
  parts: StreamPart[];
  resolveCredential: () => never;
  openNetwork: () => never;
};

export function createStubRouteDriver(parts: StreamPart[]): StubRouteDriver {
  return {
    dispatches: 0,
    officialCalls: 0,
    secondProviderCalls: 0,
    parts,
    resolveCredential() {
      throw new Error("stub route driver has credential resolution disabled");
    },
    openNetwork() {
      throw new Error("stub route driver has network disabled");
    },
  };
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
  session: PromptSession;
  dispatched: boolean;
  recorded: boolean;
  evidence: SeamEvidence;
  agentId: string;
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

export function createSessionSeam(config: SessionSeamConfig) {
  if (config.mode === "route" && !config.driver) {
    throw new Error("route seam requires a stub driver");
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
          modelId: config.modelId,
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
    if (config.mode !== "route") return args.originalSession;
    const invocationId = invocationIdOf(args.sessionOptions);
    const agentId = agentIdOf(args);
    if (invocationId == null || agentId == null) {
      return createManagedPromptSession({
        modelId: config.modelId ?? "stub/echo",
        vision: false,
        parallel: "allow",
        parts: [{ type: "finish", reason: "error" }],
      });
    }
    const existing = invocations.get(invocationId);
    if (existing) return existing.session;
    const driver = config.driver!;

    const inner = createManagedPromptSession({
      modelId: config.modelId ?? "stub/echo",
      vision: false,
      parallel: "allow",
      parts: driver.parts,
      onTerminal: (terminal: SessionTerminal) => {
        const current = invocations.get(invocationId);
        if (!current) return;
        record(current, terminal.terminalClass, terminal.toolCallCount, "managed");
      },
    });

    const state: InvocationState = {
      session: {
        stream(request) {
          if (!state.dispatched) {
            state.dispatched = true;
            driver.dispatches += 1;
          }
          return inner.stream(request);
        },
      },
      dispatched: false,
      recorded: false,
      evidence: { emitted: false, gap: null },
      agentId,
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
