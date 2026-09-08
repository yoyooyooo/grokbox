import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { OpenAiPromptMessage } from "./modeld-openai-map.ts";

export type ProductTurn = { role: "user" | "assistant"; content: string };

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOISE_USER = /SAND_HIDDEN|ack-redrive/i;
const NOISE_ASSISTANT = /The configured model request failed|No fallback model was used|No model request was sent|我查一下/;
const PING_USER = /^(?:\[t\d+u\]\s*)?(?:diag |hotfix |fidelity |canary )?ping\b/i;

export function resolveSandDataRoot(env: NodeJS.Dict<string | undefined> = process.env): string | undefined {
  for (const key of ["SAND_DATA_ROOT", "GROKBOX_SAND_DATA_ROOT"]) {
    const value = env[key];
    if (typeof value === "string" && isAbsolute(value) && !value.includes("\0")) return value;
  }
  if (existsSync("/home/box/sand-data/agents")) return "/home/box/sand-data";
  return undefined;
}

export function agentStorePath(dataRoot: string, agentId: string): string | undefined {
  if (!AGENT_ID.test(agentId) || !isAbsolute(dataRoot)) return undefined;
  return join(dataRoot, "agents", agentId, "store.db");
}

function entryText(kind: string, entry: Record<string, unknown>): { role: "user" | "assistant"; content: string } | undefined {
  if (kind === "message" && entry.role === "user" && typeof entry.content === "string") {
    const content = entry.content.trim();
    return content ? { role: "user", content } : undefined;
  }
  if (kind === "send-message") {
    const message = entry.message;
    if (message !== null && typeof message === "object" && !Array.isArray(message) && typeof (message as { content?: unknown }).content === "string") {
      const content = (message as { content: string }).content.trim();
      return content ? { role: "assistant", content } : undefined;
    }
  }
  return undefined;
}

export function productTurnsFromStoreEntries(rows: Array<{ entry: unknown }>): ProductTurn[] {
  const turns: ProductTurn[] = [];
  for (const row of rows) {
    const raw = row.entry;
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "";
    if (!text) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
    if (typeof parsed.kind !== "string") continue;
    const turn = entryText(parsed.kind, parsed);
    if (!turn) continue;
    if (turn.role === "user" && (NOISE_USER.test(turn.content) || PING_USER.test(turn.content))) continue;
    if (turn.role === "assistant" && NOISE_ASSISTANT.test(turn.content)) continue;
    turns.push(turn);
  }
  return turns;
}

export function readProductHistory(storePath: string): ProductTurn[] {
  if (!isAbsolute(storePath) || !existsSync(storePath)) return [];
  try {
    const db = new Database(storePath, { readonly: true });
    try {
      return productTurnsFromStoreEntries(db.query("SELECT entry FROM transcript_entries ORDER BY seq").all() as Array<{ entry: unknown }>);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function readProductHistoryForAgent(
  agentId: string,
  env: NodeJS.Dict<string | undefined> = process.env,
): ProductTurn[] {
  const root = resolveSandDataRoot(env);
  if (!root) return [];
  const store = agentStorePath(root, agentId);
  if (!store) return [];
  return readProductHistory(store);
}

function blob(messages: OpenAiPromptMessage[]): string {
  return messages.map((message) => String(message.content ?? "")).join("\n");
}

/** Prepend this bot's durable App turns when Host executor already compacted them out. */
export function mergeLivePromptWithProductHistory(
  prompt: { system?: string; messages: OpenAiPromptMessage[] },
  history: ProductTurn[],
): { system?: string; messages: OpenAiPromptMessage[] } {
  if (history.length === 0 || prompt.messages.length === 0) return prompt;
  const live = blob(prompt.messages);
  const early = history.find((turn) => turn.role === "user" && turn.content.length >= 8);
  if (early && live.includes(early.content.slice(0, Math.min(40, early.content.length)))) return prompt;
  const prefix: OpenAiPromptMessage[] = [];
  for (const turn of history) {
    if (live.includes(turn.content)) continue;
    prefix.push({ role: turn.role, content: turn.content });
  }
  if (prefix.length === 0) return prompt;
  const messages = [...prefix, ...prompt.messages];
  if (messages[messages.length - 1]?.role !== "user") return prompt;
  return { ...prompt, messages };
}
