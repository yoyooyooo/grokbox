import type { CliDeps } from "./deps.ts";
import { GatewayClient } from "./gateway.ts";
import type { OwnershipReader } from "@grokbox/box-runtime/runtime";

/** Local runtime borrows the existing authenticated Gateway read implementation.
 * No new RPC client, remote Profile routing, exported native credential or cache. */
export function runtimeOwnershipReader(deps: CliDeps): OwnershipReader {
  return async (agentIds, signal) => {
    const client = new GatewayClient({ ...deps, transport: "local", signal });
    const reply = await client.getAgentOwnership(agentIds, 10_000);
    return { snapshot: reply.result, gateway: { pid: reply.discovery.pid, startedAt: reply.discovery.startedAt } };
  };
}
