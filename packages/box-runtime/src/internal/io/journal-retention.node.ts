import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Observation } from "./observation.node.ts";

export type JournalRetentionReceipt = {
  version: 1;
  operationId: string;
  state: "prepared" | "applied";
  at: string;
  sourceIdentity: string;
  targetIdentity: string;
  retainedBytes: number;
  retainedRecords: number;
  droppedScannedRecords: number;
  sourcePrefixOmitted: boolean;
  priorCoverageLimited: boolean;
  policy: { maxBytes: number; maxIncidents: number; maxAgeMs: number };
};
export type JournalRetentionObservation = Observation<JournalRetentionReceipt>;
export const journalRetentionPath = (root: string) => join(root, "log", "retention.json");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1024 * 1024 * 1024;
export function parseJournalRetention(value: unknown): JournalRetentionReceipt {
  const v = record(value), policy = record(v?.policy);
  if (!v || !policy || v.version !== 1 || typeof v.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(v.operationId)
    || (v.state !== "prepared" && v.state !== "applied") || typeof v.at !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at) || !Number.isFinite(Date.parse(v.at))
    || typeof v.sourceIdentity !== "string" || !/^\d+:\d+$/.test(v.sourceIdentity)
    || typeof v.targetIdentity !== "string" || !/^\d+:\d+$/.test(v.targetIdentity)
    || !count(v.retainedBytes) || !count(v.retainedRecords) || !count(v.droppedScannedRecords)
    || typeof v.sourcePrefixOmitted !== "boolean" || typeof v.priorCoverageLimited !== "boolean"
    || !count(policy.maxBytes) || !count(policy.maxIncidents) || !count(policy.maxAgeMs)) throw new Error("invalid journal retention receipt");
  return {
    version: 1, operationId: v.operationId, state: v.state, at: v.at,
    sourceIdentity: v.sourceIdentity, targetIdentity: v.targetIdentity,
    retainedBytes: v.retainedBytes as number, retainedRecords: v.retainedRecords as number,
    droppedScannedRecords: v.droppedScannedRecords as number,
    sourcePrefixOmitted: v.sourcePrefixOmitted, priorCoverageLimited: v.priorCoverageLimited,
    policy: { maxBytes: policy.maxBytes as number, maxIncidents: policy.maxIncidents as number, maxAgeMs: policy.maxAgeMs as number },
  };
}
export async function observeJournalRetention(root: string): Promise<JournalRetentionObservation> {
  let handle;
  try {
    handle = await open(journalRetentionPath(root), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024) return { state: "invalid" };
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16 * 1024) return { state: "invalid" };
    try { return { state: "present", value: parseJournalRetention(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))) }; }
    catch { return { state: "invalid" }; }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ELOOP" || code === "ENOTDIR") return { state: "invalid" };
    return { state: "unavailable" };
  } finally { await handle?.close().catch(() => undefined); }
}

/** Unique protected temp and atomic rename. This is a receipt write under the
 * existing watchdog journal lock, not a new compactor or execution authority. */
export async function writeJournalRetention(root: string, receipt: JournalRetentionReceipt): Promise<void> {
  const path = journalRetentionPath(root), temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(parseJournalRetention(receipt))}\n`);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}
