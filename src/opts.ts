import type { CliDeps } from "./deps.ts";
import { usage } from "./errors.ts";
import { DEFAULT_TIMEOUT_MS, PROMPT_MAX_BYTES } from "./registry.ts";
import { parseInteger, stripOneTrailingNewline, utf8Bytes } from "./util.ts";

export type IoOpts = {
  json: boolean;
  table: boolean;
  timeoutMs: number;
};

export function ioFromOpts(opts: {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string | number;
}): IoOpts {
  const json = Boolean(opts.json);
  const table = Boolean(opts.table);
  if (json && table) throw usage("--json and --table cannot be used together.");
  return {
    json,
    table,
    timeoutMs: parseInteger(opts.timeoutMs, {
      name: "--timeout-ms",
      min: 1,
      max: 300_000,
      defaultValue: DEFAULT_TIMEOUT_MS,
    }),
  };
}

export function rejectTable(table: boolean, allowed: boolean): void {
  if (table && !allowed) throw usage("This command does not support --table.");
}

export async function readPrompt(text: string | undefined, deps: CliDeps): Promise<string> {
  let prompt: string;
  if (text !== undefined) {
    prompt = text;
  } else if (deps.stdinIsTTY) {
    throw usage("Provide --text or pipe stdin. Interactive prompts are not supported.");
  } else {
    prompt = await deps.readStdin();
  }
  prompt = stripOneTrailingNewline(prompt);
  if (prompt.length === 0) throw usage("Prompt is empty.");
  if (utf8Bytes(prompt) > PROMPT_MAX_BYTES) throw usage("Prompt exceeds the 64 KiB CLI limit.");
  return prompt;
}
