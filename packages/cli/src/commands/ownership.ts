import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { projectOwnership } from "../ownership.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { inspectOperator } from "./operator.ts";
import { findRosterRow } from "./roster.ts";

export async function runAgentsOwnership(deps: CliDeps, targets: string[], raw: { timeoutMs?: string }): Promise<void> {
  if (targets.length < 1 || targets.length > 32) throw usage("ownership requires 1 to 32 named targets.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const roster = await client.listAgents(io.timeoutMs);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // An explicit public UUID can be inspected even when local materialization is
  // missing. Names still require the normal unambiguous Gateway resolver.
  const agentIds = targets.map(target => uuid.test(target) ? target.toLowerCase() : String(findRosterRow(roster.agents, target, ["agent"]).id));
  if (agentIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    || new Set(agentIds).size !== agentIds.length) throw usage("ownership targets must resolve to distinct Agent UUIDs.");
  const observation = await client.getAgentOwnership(agentIds, io.timeoutMs);
  const changed = roster.discovery.pid !== observation.discovery.pid || roster.discovery.startedAt !== observation.discovery.startedAt;
  const operator = await inspectOperator(deps, io.timeoutMs).catch(() => undefined);
  writeSuccess(deps.stdout, projectOwnership({
    agentIds,
    snapshot: observation.result,
    gatewayChanged: changed,
    host: operator?.host,
    hostNext: operator?.next,
    hostReason: operator?.hostReason,
  }), gatewayMeta(observation.discovery));
}
