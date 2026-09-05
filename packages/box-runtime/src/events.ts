import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eventsPath } from "./paths.ts";

export const EVENT_NAMES = [
  "disk_sha_observed",
  "contracts_snapshot",
  "attestation_invalidated",
  "census",
  "stale_patched_detected",
  "stale_patched_term",
  "circuit_open",
  "inject_phase",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const ALLOWED_FIELDS = new Set([
  "name",
  "at",
  "sha",
  "oldSha",
  "newDiskSha",
  "outcome",
  "reason",
  "counts",
  "driftedSlices",
  "phase",
  "pid",
  "start",
]);

const FORBIDDEN = /env|token|prompt|authorization|secret|apiKey/i;

export type RuntimeEvent = {
  name: EventName;
  at: string;
  [key: string]: unknown;
};

export function sanitizeEvent(input: RuntimeEvent): RuntimeEvent {
  const out: RuntimeEvent = { name: input.name, at: input.at };
  for (const [key, value] of Object.entries(input)) {
    if (key === "name" || key === "at") continue;
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (FORBIDDEN.test(key)) continue;
    if (typeof value === "string" && FORBIDDEN.test(value)) continue;
    out[key] = value;
  }
  return out;
}

export async function appendEvent(root: string, event: RuntimeEvent): Promise<void> {
  const path = eventsPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const lines = existing.split("\n").filter((line) => line.length > 0);
  lines.push(JSON.stringify(sanitizeEvent(event)));
  const kept = lines.slice(-256);
  await writeFile(path, `${kept.join("\n")}\n`, { mode: 0o600 });
}
