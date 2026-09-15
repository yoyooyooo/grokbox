import { inspectOwnership } from "@grokbox/runtime-kernel/contract";
import type { OperatorHost } from "./commands/operator.ts";
import { profileWriteNext } from "./host-source.ts";

const HOST_START = "grokbox host start";

/** CLI projection reuses the same finite source facts as runtime admission. */
export function projectOwnership(input: {
  agentIds: string[];
  snapshot: unknown;
  gatewayChanged?: boolean;
  host?: OperatorHost;
  hostNext?: string;
  hostReason?: string | null;
  liveSha?: string | null;
}) {
  const result = inspectOwnership(input);
  return annotateOwnershipHost(result, input.host, input.hostNext, input.hostReason, input.liveSha);
}

export function annotateOwnershipHost<T extends {
  agents: Array<{ blockers: string[]; nextAction: string }>;
}>(
  result: T,
  host?: OperatorHost,
  hostNext?: string,
  hostReason?: string | null,
  liveSha?: string | null,
): T & { next: string } {
  if (hostReason === "source_mismatch") {
    const next = profileWriteNext(liveSha);
    return {
      ...result,
      next,
      agents: result.agents.map((agent) => ({
        ...agent,
        blockers: [
          "host_source_mismatch",
          ...agent.blockers.filter((code) => code !== "host_source_mismatch" && code !== "host_channel_not_enabled"),
        ],
        nextAction: next,
        next,
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
