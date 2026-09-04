import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { projectSearchHit } from "../redaction.ts";
import { isRecord, parseInteger } from "../util.ts";
import { findRosterRow } from "./roster.ts";

export async function runHistorySearch(
  deps: CliDeps,
  query: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (query.trim().length === 0) throw usage("Search query must not be blank.");
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 100, defaultValue: 20 });
  const client = new GatewayClient(deps);
  const { matches, discovery } = await client.searchAgents(query, limit, io.timeoutMs);
  writeSuccess(deps.stdout, { matches: matches.map(projectSearchHit) }, gatewayMeta(discovery));
}

export async function runHistoryTail(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string; beforeSeq?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 200, defaultValue: 50 });
  const beforeSeq =
    raw.beforeSeq === undefined
      ? undefined
      : parseInteger(raw.beforeSeq, { name: "--before-seq", min: 0, max: Number.MAX_SAFE_INTEGER });
  const client = new GatewayClient(deps);
  const roster = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(roster.agents, target);
  const id = String(row.id);
  const { result, discovery } = await client.getAgentTranscriptTail(
    beforeSeq === undefined ? { id, limit } : { id, limit, beforeSeq },
    io.timeoutMs,
  );
  const payload = isRecord(result) ? result : {};
  const data: Record<string, unknown> = {
    id,
    entries: Array.isArray(payload.entries) ? payload.entries : [],
  };
  if (payload.nextBeforeSeq !== undefined && payload.nextBeforeSeq !== null) {
    data.nextBeforeSeq = payload.nextBeforeSeq;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(discovery));
}

export async function runHistoryThread(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; root?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const rootId = raw.root;
  if (!rootId) throw usage("--root is required.");
  const client = new GatewayClient(deps);
  const roster = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(roster.agents, target);
  const id = String(row.id);
  const { result, discovery } = await client.getAgentThread({ id, rootId }, io.timeoutMs);
  const payload = isRecord(result) ? result : {};
  writeSuccess(
    deps.stdout,
    { id, rootId, entries: Array.isArray(payload.entries) ? payload.entries : [] },
    gatewayMeta(discovery),
  );
}
