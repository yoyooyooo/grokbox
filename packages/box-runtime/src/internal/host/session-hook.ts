import type { HostBinding } from "./host-binding.ts";
import { captureHostSelection } from "./selection.node.ts";
import { createModeldProduce, hostEpochFromBinding } from "./modeld-produce.node.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  visibleFailureHandle,
} from "./session.ts";
import { appendHostStreamRejected, appendTurnSeamTerminal } from "./terminal-journal.node.ts";

export type SeamMode = "observe" | "identity" | "route";

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
}): (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string }) => unknown {
  if (input.mode !== "route") return (args) => args.originalSession;
  return (args) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : undefined;
    const captured = captureHostSelection(input.durableRoot, agentId);
    if (captured.kind === "official") return args.originalSession;
    const modelId = captured.modelId;
    const produce = createModeldProduce({
      runRoot: input.runRoot,
      agentId: agentId ?? "agent",
      modelId,
      selectionRevision: captured.selectionRevision,
      hostEpoch: hostEpochFromBinding(input.binding),
    });
    const session = createStreamingPromptSession({
      modelId,
      vision: false,
      parallel: "fail-closed",
      produce,
      agentId,
      onTerminal: (terminal) => {
        void appendTurnSeamTerminal(input.runRoot, {
          name: "turn_seam_terminal",
          at: new Date().toISOString(),
          mode: "route",
          agentId: agentId ?? "agent",
          assignment: "agent",
          modelId,
          invocationId: "host-step",
          toolCallCount: terminal.toolCallCount,
          terminalClass: terminal.terminalClass,
          outcome: terminal.rejected ? "rejected" : "managed",
          ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
        });
      },
    });
    return asHostPromptSession(session, modelId, undefined, {
      requireStepId: true,
      reject: (code, detail) => {
        void appendHostStreamRejected(input.runRoot, {
          name: "host_stream_rejected",
          schemaVersion: 2,
          invocationId: detail?.invocationId,
          reason: detail?.reason,
        });
        return visibleFailureHandle(modelId, code);
      },
    });
  };
}
