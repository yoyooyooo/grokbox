import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ObservationState } from "./observation.node.ts";

export const JOURNAL_READ_MAX_BYTES = 8 * 1024 * 1024;
export const JOURNAL_LINE_MAX_BYTES = 64 * 1024;
export const JOURNAL_READ_MAX_LINES = 32_768;
export type JournalWindow = {
  fileBytes: number | null;
  readBytes: number;
  startOffset: number | null;
  endOffset: number | null;
  prefixOmitted: boolean;
  trailingPartial: boolean;
  malformedLines: number;
  oversizedLines: number;
  changedDuringRead: boolean;
  linesOmitted: boolean;
  reason: "none" | "missing" | "not_regular" | "unavailable" | "changed";
};
export type JournalRead = { state: ObservationState | "partial"; lines: string[]; window: JournalWindow };
const emptyWindow = (): JournalWindow => ({ fileBytes: null, readBytes: 0, startOffset: null, endOffset: null,
  prefixOmitted: false, trailingPartial: false, malformedLines: 0, oversizedLines: 0, changedDuringRead: false, linesOmitted: false, reason: "none" });

/** Read a fixed suffix of one opened inode. No repair, lock, compaction or writes.
 * O_NONBLOCK prevents a malicious FIFO from hanging before the regular-file check. */
export async function readJournalWindow(path: string, maxBytes = JOURNAL_READ_MAX_BYTES): Promise<JournalRead> {
  const window = emptyWindow();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > JOURNAL_READ_MAX_BYTES) return { state: "invalid", lines: [], window };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) { window.reason = "not_regular"; return { state: "invalid", lines: [], window }; }
    const end = before.size, start = Math.max(0, end - maxBytes), begin = start > 0 ? start - 1 : 0;
    window.fileBytes = end; window.startOffset = start; window.endOffset = end; window.prefixOmitted = start > 0;
    const buffer = Buffer.alloc(end - begin);
    let read = 0;
    while (read < buffer.length) {
      const part = await handle.read(buffer, read, Math.min(64 * 1024, buffer.length - read), begin + read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    window.readBytes = read;
    const after = await handle.stat();
    let pathChanged = false;
    try { const current = await lstat(path); pathChanged = !current.isFile() || current.dev !== before.dev || current.ino !== before.ino; }
    catch { pathChanged = true; }
    // Appending after the fixed end does not invalidate the captured window.
    // Truncation or same-size rewrite can invalidate its contents.
    if (read !== buffer.length || after.size < end || pathChanged || (after.size === end && after.mtimeMs !== before.mtimeMs)) {
      window.changedDuringRead = true; window.reason = "changed";
    }
    const raw = buffer.subarray(0, read), lines: string[] = [];
    // Bound object count as well as bytes. Only the newest complete lines are
    // materialized; a tiny-line flood cannot create millions of JS objects.
    let lineStart = raw.length, boundaries = 0;
    while (lineStart > 0) {
      const at = raw.lastIndexOf(10, lineStart - 1);
      if (at < 0) break;
      boundaries++; lineStart = at;
      if (boundaries > JOURNAL_READ_MAX_LINES) { lineStart = at + 1; window.linesOmitted = true; break; }
    }
    let offset = window.linesOmitted ? lineStart : 0;
    if (start > 0 && !window.linesOmitted) offset = raw[0] === 10 ? 1 : raw.indexOf(10) + 1;
    if (start > 0 && offset === 0) { window.oversizedLines++; offset = raw.length; }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const newline = raw.indexOf(10, offset);
      if (newline < 0) break;
      if (newline - offset > JOURNAL_LINE_MAX_BYTES) window.oversizedLines++;
      else if (newline > offset) {
        try { const line = decoder.decode(raw.subarray(offset, newline)); if (line.trim()) lines.push(line); }
        catch { window.malformedLines++; }
      }
      offset = newline + 1;
    }
    window.trailingPartial = offset < raw.length;
    const partial = window.changedDuringRead || window.trailingPartial || window.malformedLines > 0 || window.oversizedLines > 0;
    return { state: partial ? "partial" : "present", lines, window };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    window.reason = code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_regular" : "unavailable";
    return { state: code === "ENOENT" ? "missing" : code === "ELOOP" ? "invalid" : "unavailable", lines: [], window };
  } finally { await handle?.close().catch(() => undefined); }
}
