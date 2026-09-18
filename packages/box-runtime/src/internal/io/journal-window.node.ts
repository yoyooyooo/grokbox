import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ObservationState } from "./observation.node.ts";

export const JOURNAL_TAIL_READ_BYTES = 1024 * 1024;
export const JOURNAL_LOOKUP_READ_BYTES = 16 * 1024 * 1024;
export const JOURNAL_LINE_MAX_BYTES = 64 * 1024;
export const JOURNAL_SCAN_MAX_RECORDS = 65_536;
export type JournalCoverage = {
  fileBytes: number;
  byteStart: number;
  byteEnd: number;
  bytesRead: number;
  prefixOmitted: boolean;
  partialLastLine: boolean;
  invalidLines: number;
  rotatedDuringRead: boolean;
  truncatedDuringRead: boolean;
  snapshot: "descriptor-pinned";
  fileIdentity: string;
  recordLimitHit: boolean;
  segmentCoverage?: { indexRevision: number; retiredThrough: number; retiredSegments: number; retiredBytes: number;
    gaps: string[]; consistency: "per-segment-descriptor"; segments: Array<{ id: string; sequence: number; identity: string; bytesRead: number }> };
};
export type JournalWindow = {
  state: ObservationState;
  lines: Array<string | null>;
  /** Internal byte positions, paired with lines. Never infer source line numbers. */
  positions?: number[];
  coverage?: JournalCoverage;
  failure?: "not_regular" | "symlink_or_path" | "permission" | "read_failed" | "invalid_budget";
};

/** Reads at most maxBytes (+ one boundary byte), regardless of the journal's
 * total size. Never locks, repairs, compacts, mkdirs, or follows the final symlink.
 * A trailing partial append is not a malformed completed record. */
export async function readJournalWindow(path: string, maxBytes = JOURNAL_TAIL_READ_BYTES): Promise<JournalWindow> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > JOURNAL_LOOKUP_READ_BYTES) {
    return { state: "invalid", lines: [], failure: "invalid_budget" };
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return { state: "invalid", lines: [], failure: "not_regular" };
    const start = Math.max(0, before.size - maxBytes);
    const readStart = start > 0 ? start - 1 : 0;
    const buffer = Buffer.alloc(before.size - readStart);
    let used = 0;
    while (used < buffer.length) {
      const next = await handle.read(buffer, used, buffer.length - used, readStart + used);
      if (next.bytesRead === 0) break;
      used += next.bytesRead;
    }
    const raw = buffer.subarray(0, used);
    let first = 0;
    if (start > 0) {
      // The preceding byte establishes whether start is already on a boundary.
      first = raw[0] === 10 ? 1 : raw.indexOf(10) + 1;
      if (first === 0) first = raw.length;
    }
    let end = raw.length;
    const partialLastLine = end > 0 && raw[end - 1] !== 10;
    if (partialLastLine) end = Math.max(first, raw.lastIndexOf(10) + 1);
    let invalidLines = 0;
    const lines: Array<string | null> = [];
    const positions: number[] = [];
    let cursor = end;
    while (cursor > first && lines.length < JOURNAL_SCAN_MAX_RECORDS) {
      const previous = cursor - 2 >= first ? raw.lastIndexOf(10, cursor - 2) : first - 1;
      const lineStart = Math.max(first, previous + 1);
      const bytes = raw.subarray(lineStart, raw[cursor - 1] === 10 ? cursor - 1 : cursor);
      cursor = lineStart;
      if (bytes.length === 0) continue;
      positions.push(readStart + lineStart);
      if (bytes.length > JOURNAL_LINE_MAX_BYTES) { invalidLines++; lines.push(null); continue; }
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) { invalidLines++; lines.push(null); continue; }
      lines.push(text);
    }
    const recordLimitHit = cursor > first;
    first = cursor;
    lines.reverse(); positions.reverse();
    const after = await handle.stat();
    const current = await lstat(path).catch(() => undefined);
    const coverage: JournalCoverage = {
      fileBytes: before.size,
      byteStart: readStart + first,
      byteEnd: readStart + end,
      bytesRead: used,
      prefixOmitted: readStart + first > 0,
      partialLastLine,
      invalidLines,
      rotatedDuringRead: current === undefined || current.ino !== before.ino || current.dev !== before.dev,
      truncatedDuringRead: used < buffer.length || after.size < before.size,
      snapshot: "descriptor-pinned",
      fileIdentity: `${before.dev}:${before.ino}`,
      recordLimitHit,
    };
    return { state: "present", lines, positions, coverage };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { state: "missing", lines: [] };
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") return { state: "invalid", lines: [], failure: "symlink_or_path" };
    if (code === "EACCES" || code === "EPERM") return { state: "unavailable", lines: [], failure: "permission" };
    return { state: "unavailable", lines: [], failure: "read_failed" };
  } finally { await handle?.close().catch(() => undefined); }
}
