import { inspectOwnership } from "@grokbox/runtime-kernel/contract";
import type { OperatorHost } from "./commands/operator.ts";
import { PROFILE_WRITE_NEXT } from "./host-source.ts";

const HOST_START = "grokbox host start";

/** CLI projection reuses the same finite source facts as runtime admission. */
export function projectOwnership(input: {
  agentIds: string[];
  snapshot: unknown;
  gatewayChanged?: boolean;
  host?: OperatorHost;
  hostNext?: string;
  hostReason?: string | null;
}) {
  const result = inspectOwnership(input);
  return annotateOwnershipHost(result, input.host, input.hostNext, input.hostReason);
}

export function annotateOwnershipHost<T extends {
  agents: Array<{ blockers: string[]; nextAction: string }>;
}>(result: T, host?: OperatorHost, hostNext?: string, hostReason?: string | null): T & { next: string } {
  if (hostReason === "source_mismatch") {
    return {
      ...result,
      next: PROFILE_WRITE_NEXT,
      agents: result.agents.map((agent) => ({
        ...agent,
        blockers: [
          "host_source_mismatch",
          ...agent.blockers.filter((code) => code !== "host_source_mismatch" && code !== "host_channel_not_enabled"),
        ],
        nextAction: PROFILE_WRITE_NEXT,
        next: PROFILE_WRITE_NEXT,
      })),
    };
  }
  if (host === "official") {
    return {
      ...result,
      next: HOST_START,
      agents: result.agents.map((agent) => ({
        ...agent,
        blockers: [ "host_channel_not_enabled", ...agent.blockers.filter((code) => code !== "host_channel_not_enabled") ],
        nextAction: HOST_START,
        next: HOST_START,
      })),
    };
  }
  return { ...result, next: hostNext ?? "none" };
}
