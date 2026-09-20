import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ManagementClientError, REQUEST_MAX_BYTES } from "@grokbox/client";
import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import type { CliDeps } from "./deps.ts";

const invalid = () => new ManagementClientError("invalid_input", "Input must be one bounded strict JSON object from @file or explicit stdin.");
export async function readManagementInput(deps: CliDeps, source: string | undefined): Promise<Record<string, unknown>> {
  if (source !== "-" && (!source?.startsWith("@") || source.length < 2)) throw invalid();
  try {
    deps.signal?.throwIfAborted();
    let text: string;
    if (source === "-") text = await deps.readStdin(REQUEST_MAX_BYTES);
    else {
      const handle = await open(source!.slice(1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > REQUEST_MAX_BYTES) throw invalid();
        const bytes = Buffer.alloc(REQUEST_MAX_BYTES + 1);
        let total = 0;
        while (total < bytes.length) {
          deps.signal?.throwIfAborted();
          const result = await handle.read(bytes, total, bytes.length - total, total);
          if (!result.bytesRead) break;
          total += result.bytesRead;
        }
        const after = await handle.stat();
        if (total > REQUEST_MAX_BYTES || total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid();
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
      } finally { await handle.close(); }
    }
    if (Buffer.byteLength(text) > REQUEST_MAX_BYTES) throw invalid();
    const value = parseConfigJson(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
  } catch {
    if (deps.signal?.aborted) throw new ManagementClientError("unavailable", "Input was interrupted before submission.");
    throw invalid();
  }
}

export function combineManagementInput(input: Record<string, unknown>, flags: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
  const result = { ...input };
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    if (Object.hasOwn(result, key)) throw new ManagementClientError("invalid_input", "A semantic input field was supplied more than once.");
    result[key] = value;
  }
  return result;
}
