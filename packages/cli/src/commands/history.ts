import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { isRecord, parseInteger } from "../util.ts";
import { managementClient } from "../management-client.ts";

export async function runHistorySearch(
  deps: CliDeps,
  query: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (query.trim().length === 0) throw usage("Search query must not be blank.");
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 100, defaultValue: 20 });
  const { client } = await managementClient(deps, { timeoutMs: String(io.timeoutMs) });
  const reply = await client.searchMessages(query, { limit });
  writeSuccess(deps.stdout, reply.data);
}

export async function runHistoryTail(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string; beforeSeq?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 200, defaultValue: 50 });
  const beforeSeq = raw.beforeSeq === undefined ? undefined : parseInteger(raw.beforeSeq, { name: "--before-seq", min: 0, max: Number.MAX_SAFE_INTEGER });
  const { client } = await managementClient(deps, { timeoutMs: String(io.timeoutMs) });
  const row = await client.resolveBot(target);
  const reply = await client.messages(row.data.bot.botRef, { limit, beforeSeq });
  writeSuccess(deps.stdout, reply.data);
}

export async function runHistoryThread(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; root?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (!raw.root) throw usage("--root is required.");
  const { client } = await managementClient(deps, { timeoutMs: String(io.timeoutMs) });
  const row = await client.resolveBot(target);
  const reply = await client.messageThread(row.data.bot.botRef, raw.root);
  writeSuccess(deps.stdout, reply.data);
}
