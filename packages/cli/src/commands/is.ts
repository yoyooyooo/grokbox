import type { CliDeps } from "../deps.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { flattenRows, formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { runningProjection } from "../redaction.ts";
import { findRosterRow } from "./roster.ts";

export async function runIsRunning(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target);
  const data = runningProjection(row, deps.now());
  if (io.table) {
    deps.stdout.write(formatTable(flattenRows(data as unknown as Record<string, unknown>)));
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(discovery));
}
