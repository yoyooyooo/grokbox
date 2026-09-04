import type { CliDeps } from "../deps.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { projectMemory } from "../redaction.ts";
import { MEMORY_UPSTREAM_CAP } from "../registry.ts";
import { parseInteger } from "../util.ts";
import { findRosterRow } from "./roster.ts";

export async function runMemoryList(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string; content?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const includeContent = Boolean(raw.content);
  const limit = parseInteger(raw.limit, {
    name: "--limit",
    min: 1,
    max: MEMORY_UPSTREAM_CAP,
    defaultValue: 100,
  });
  const client = new GatewayClient(deps);
  const roster = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(roster.agents, target, ["agent"]);
  const agentId = String(row.id);
  const { result, discovery } = await client.getAgentMemories(agentId, io.timeoutMs);
  const source = Array.isArray(result) ? result : [];
  const sliced = source.slice(0, limit);
  writeSuccess(
    deps.stdout,
    {
      agentId,
      returned: sliced.length,
      sourceCount: source.length,
      sourceMayBeTruncated: source.length === MEMORY_UPSTREAM_CAP,
      memories: sliced.map((memory) => projectMemory(memory, includeContent)),
    },
    gatewayMeta(discovery),
  );
}
