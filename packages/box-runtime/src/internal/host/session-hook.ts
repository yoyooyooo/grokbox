import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { decideRouteSession } from "@grokbox/runtime-kernel/selection";
import type { HostBinding } from "./host-binding.ts";
import { loadModelsFileSync } from "./selection.node.ts";

export type SeamMode = "observe" | "identity" | "route";

/**
 * Identity/observe: official session passthrough.
 * Route + unassigned agent: official passthrough (S4.1).
 * Route + managed assignment: T26 inference is not ready — visible runtime_not_ready, never StubRouteDriver/callStubModeld.
 */
export function bindHostSessionHook(input: {
  mode: SeamMode;
  durableRoot: string;
  runRoot: string;
  binding?: HostBinding;
}): (args: { originalSession: unknown; sessionOptions?: unknown; agentId?: string }) => unknown {
  void input.runRoot;
  void input.binding;
  if (input.mode !== "route") return (args) => args.originalSession;
  return (args) => {
    const file = loadModelsFileSync(input.durableRoot);
    const agentId = typeof args.agentId === "string" ? args.agentId : undefined;
    if (!file) return args.originalSession;
    const decided = decideRouteSession(file, agentId);
    if (decided.kind === "official") return args.originalSession;
    throw new BoxRuntimeError(
      "runtime_not_ready",
      "managed route inference is not ready (T26). No credential, network, or modeld dispatch ran.",
      { userVisible: true },
    );
  };
}
