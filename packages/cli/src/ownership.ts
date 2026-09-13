import { inspectOwnership } from "@grokbox/runtime-kernel/contract";

/** CLI projection reuses the same finite source facts as runtime admission. */
export function projectOwnership(input: { agentIds: string[]; snapshot: unknown; gatewayChanged?: boolean }) {
  return inspectOwnership(input);
}
