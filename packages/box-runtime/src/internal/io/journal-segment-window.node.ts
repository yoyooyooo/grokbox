import { inspectJournalSegments, isJournalSegmentHeader } from "../host/journal-segments.node.ts";
import { eventsPath } from "./paths.ts";
import { readJournalWindow, JOURNAL_TAIL_READ_BYTES, JOURNAL_LOOKUP_READ_BYTES, JOURNAL_SCAN_MAX_RECORDS, type JournalWindow, type JournalCoverage } from "./journal-window.node.ts";

/** Bounded suffix across the currently registered segments. Byte positions refer
 * to the captured concatenation, not a fictional original line number. Each
 * descriptor is pinned independently; concurrent rotation is disclosed. */
export async function readObservationJournalWindow(root: string, maxBytes = JOURNAL_TAIL_READ_BYTES): Promise<JournalWindow> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > JOURNAL_LOOKUP_READ_BYTES) return { state: "invalid", lines: [], failure: "invalid_budget" };
  let inventory: Awaited<ReturnType<typeof inspectJournalSegments>>;
  try { inventory = await inspectJournalSegments(root); }
  catch { return { state: "unavailable", lines: [], failure: "read_failed" }; }
  if (inventory.mode === "legacy") return readJournalWindow(eventsPath(root), maxBytes);
  const total = inventory.entries.reduce((n, s) => n + s.bytes, 0);
  const chunks: Array<{ lines: Array<string | null>; positions: number[] }> = [];
  const segments: Array<{ id: string; sequence: number; identity: string; bytesRead: number }> = [];
  let remaining = maxBytes, offset = total, readBytes = 0, invalidLines = 0;
  let partialLastLine = false, rotated = inventory.gaps.length > 0, truncated = false, limitHit = false, byteStart = total;
  for (const segment of [...inventory.entries].reverse()) {
    offset -= segment.bytes;
    if (remaining <= 0) break;
    const read = await readJournalWindow(segment.path, remaining);
    if (!read.coverage || read.state !== "present") { rotated = true; continue; }
    const c = read.coverage;
    remaining -= c.bytesRead; readBytes += c.bytesRead;
    if (c.fileIdentity !== `${segment.device}:${segment.inode}` || segment.sealed && c.fileBytes !== segment.bytes) { rotated = true; continue; }
    if (c.fileBytes !== segment.bytes) rotated = true;
    segments.push({ id: segment.id, sequence: segment.sequence, identity: c.fileIdentity, bytesRead: c.bytesRead });
    invalidLines += c.invalidLines;
    partialLastLine ||= c.partialLastLine; rotated ||= c.rotatedDuringRead; truncated ||= c.truncatedDuringRead; limitHit ||= c.recordLimitHit;
    byteStart = Math.min(byteStart, offset + c.byteStart);
    const lines: Array<string | null> = [], positions: number[] = [];
    for (let i = 0; i < read.lines.length; i++) {
      const line = read.lines[i]!;
      if (line !== null) { try { if (isJournalSegmentHeader(JSON.parse(line))) continue; } catch { /* original reader owns malformed lines */ } }
      lines.push(line); positions.push(offset + (read.positions?.[i] ?? c.byteStart));
    }
    chunks.unshift({ lines, positions });
  }
  let lines = chunks.flatMap(c => c.lines), positions = chunks.flatMap(c => c.positions);
  if (lines.length > JOURNAL_SCAN_MAX_RECORDS) { limitHit = true; lines = lines.slice(-JOURNAL_SCAN_MAX_RECORDS); positions = positions.slice(-JOURNAL_SCAN_MAX_RECORDS); byteStart = positions[0] ?? byteStart; }
  try { if ((await inspectJournalSegments(root)).revision !== inventory.revision) rotated = true; } catch { rotated = true; }
  if (!segments.length && inventory.gaps.length) return { state: "unavailable", lines: [], failure: "read_failed" };
  const coverage: JournalCoverage = { fileBytes: total, byteStart, byteEnd: total, bytesRead: readBytes,
    prefixOmitted: byteStart > 0 || inventory.retiredSegments > 0, partialLastLine, invalidLines,
    rotatedDuringRead: rotated, truncatedDuringRead: truncated, snapshot: "descriptor-pinned",
    fileIdentity: `segments:${inventory.revision}`, recordLimitHit: limitHit,
    segmentCoverage: { indexRevision: inventory.revision, retiredThrough: inventory.retiredThrough,
      retiredSegments: inventory.retiredSegments, retiredBytes: inventory.retiredBytes, gaps: inventory.gaps,
      consistency: "per-segment-descriptor", segments: segments.reverse() } };
  return { state: "present", lines, positions, coverage };
}
