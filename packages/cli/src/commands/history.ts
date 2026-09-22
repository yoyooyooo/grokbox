import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { managementClient } from "../management-client.ts";
import { parseInteger } from "../util.ts";

export async function runHistorySearch(
  deps: CliDeps,
  query: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string },
): Promise<void> {
  if (query.trim().length === 0) throw usage("Search query must not be blank.");
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 100, defaultValue: 20 });
  const { client } = await managementClient(deps, { timeoutMs: raw.timeoutMs });
  const reply = await client.searchMessages(query, { limit, signal: deps.signal });
  writeSuccess(deps.stdout, { matches: reply.data.matches.map(hit => ({
    agentId: hit.botRef, entryId: hit.entry.id, role: hit.entry.role, timestampMs: hit.entry.observedAtMs ?? 0, snippet: hit.entry.text ?? "",
  })) });
}

export async function runHistoryTail(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; limit?: string; beforeSeq?: string },
): Promise<void> {
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 200, defaultValue: 50 });
  const beforeSeq =
    raw.beforeSeq === undefined
      ? undefined
      : parseInteger(raw.beforeSeq, { name: "--before-seq", min: 0, max: Number.MAX_SAFE_INTEGER });
  const { client } = await managementClient(deps, { timeoutMs: raw.timeoutMs });
  const resolved = await client.resolveBot(target, deps.signal);
  const reply = await client.messages(resolved.data.bot.botRef, { limit, beforeSeq, signal: deps.signal });
  writeSuccess(deps.stdout, { id: resolved.data.bot.id, botRef: resolved.data.bot.botRef, entries: reply.data.entries, nextBeforeSeq: reply.data.nextBeforeSeq });
}

export async function runHistoryThread(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; root?: string },
): Promise<void> {
  const rootId = raw.root;
  if (!rootId) throw usage("--root is required.");
  const { client } = await managementClient(deps, { timeoutMs: raw.timeoutMs });
  const resolved = await client.resolveBot(target, deps.signal);
  const reply = await client.messageThread(resolved.data.bot.botRef, rootId, { signal: deps.signal });
  writeSuccess(deps.stdout, { id: resolved.data.bot.id, botRef: resolved.data.bot.botRef, rootId, entries: reply.data.entries });
}
