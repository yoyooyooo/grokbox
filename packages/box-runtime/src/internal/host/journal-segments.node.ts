import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { OBSERVATION_RETENTION } from "@grokbox/runtime-kernel/observation";

/** Byte rotation only. All mutation callers hold the existing events.lock.
 * The Host retains its append writer; no SQLite, RPC, Effect or semantic
 * compaction is introduced in this leaf. Readers never recover or initialize. */
export type JournalSegmentPolicy = { segmentBytes: number; maxBytes: number; maxAgeMs: number };
export const JOURNAL_SEGMENT_POLICY: JournalSegmentPolicy = Object.freeze({
  segmentBytes: OBSERVATION_RETENTION.journalSegmentBytes,
  maxBytes: OBSERVATION_RETENTION.journalMaxBytes,
  maxAgeMs: OBSERVATION_RETENTION.journalMaxAgeMs,
});
const FORMAT = "grokbox.journal-segments", INDEX = "events.segments.json", TEMP = "events.segments.next.json";
const INDEX_BYTES = 32 * 1024, MAX_SEGMENTS = 64, MAX_LINE_BYTES = 64 * 1024;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const digits = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,30}$/.test(v);
const missing = (e: unknown) => e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
const invalid = (): never => { throw new Error("journal_segment_integrity"); };
export type JournalSegment = { id: string; sequence: number; device: string; inode: string; bytes: number; createdAtMs: number };
type Pending = { source: JournalSegment; nextId: string; nextSequence: number; atMs: number };
type Index = {
  schemaVersion: 1; format: typeof FORMAT; revision: number;
  active: JournalSegment; closed: JournalSegment[]; garbage: JournalSegment[];
  pending: Pending | null; retiredThrough: number; retiredSegments: number; retiredBytes: number;
};
export type RotationStage = "intent" | "renamed" | "created" | "committed" | "retired";
export type JournalRotationOptions = { policy?: Partial<JournalSegmentPolicy>; nowMs?: number; afterStage?: (stage: RotationStage) => void };
const activePath = (root: string) => join(root, "log", "events.ndjson");
const archivePath = (root: string, id: string) => join(root, "log", `events.segment-${id}.ndjson`);
function validateSegment(v: JournalSegment) {
  if (!v || !uuid(v.id) || !uint(v.sequence) || v.sequence < 1 || !digits(v.device) || !digits(v.inode)
    || !uint(v.bytes) || !uint(v.createdAtMs) || v.createdAtMs < 1) invalid();
}
function validateIndex(v: Index): Index {
  if (!v || v.schemaVersion !== 1 || v.format !== FORMAT || !uint(v.revision) || v.revision < 1
    || !Array.isArray(v.closed) || !Array.isArray(v.garbage) || v.closed.length + v.garbage.length > MAX_SEGMENTS
    || !uint(v.retiredThrough) || !uint(v.retiredSegments) || !uint(v.retiredBytes)) invalid();
  [v.active, ...v.closed, ...v.garbage].forEach(validateSegment);
  const entries = [v.active, ...v.closed, ...v.garbage];
  if (new Set(entries.map(s => s.id)).size !== entries.length || new Set(entries.map(s => s.sequence)).size !== entries.length
    || v.closed.some(s => s.sequence >= v.active.sequence) || v.garbage.some(s => s.sequence >= v.active.sequence)) invalid();
  if (v.pending !== null) {
    const p = v.pending; if (!p || !uuid(p.nextId) || !uint(p.nextSequence) || p.nextSequence !== v.active.sequence + 1
      || !uint(p.atMs) || p.atMs < 1) invalid();
    validateSegment(p.source);
    if (p.source.id !== v.active.id || p.source.sequence !== v.active.sequence || p.source.device !== v.active.device
      || p.source.inode !== v.active.inode || entries.some(s => s.id === p.nextId)) invalid();
  }
  return v;
}
async function safeStat(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0
    || (process.getuid && st.uid !== process.getuid())) invalid();
  return st;
}
async function readIndexFile(path: string): Promise<Index | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > INDEX_BYTES || (st.mode & 0o077) !== 0
      || (process.getuid && st.uid !== process.getuid())) invalid();
    return validateIndex(JSON.parse(await file.readFile("utf8")) as Index);
  } catch (e) { if (missing(e)) return null; throw e; }
  finally { await file?.close(); }
}
async function checkDirectory(root: string, privateMode = true) {
  const dir = await lstat(join(root, "log"));
  if (!dir.isDirectory() || dir.isSymbolicLink() || privateMode && (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid())) invalid();
}
async function syncDirectory(root: string) {
  const handle = await open(join(root, "log"), constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publish(root: string, index: Index) {
  validateIndex(index);
  const bytes = Buffer.from(JSON.stringify(index) + "\n"); if (bytes.length > INDEX_BYTES) invalid();
  const path = join(root, "log", INDEX), temp = join(root, "log", TEMP);
  // Only an owned, validated staging index left by this protocol is reclaimable.
  if (await readIndexFile(temp)) await unlink(temp);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path); await syncDirectory(root);
}
function matches(st: Awaited<ReturnType<typeof lstat>>, s: JournalSegment, closed = false) {
  return String(st.dev) === s.device && String(st.ino) === s.inode && (!closed || st.size === s.bytes);
}
function descriptor(st: Awaited<ReturnType<typeof lstat>>, id: string, sequence: number, createdAtMs: number): JournalSegment {
  return { id, sequence, createdAtMs, device: String(st.dev), inode: String(st.ino), bytes: Number(st.size) };
}
async function partialTail(path: string, size: number) {
  if (!size) return false;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const byte = Buffer.alloc(1); const read = await file.read(byte, 0, 1, size - 1); return read.bytesRead !== 1 || byte[0] !== 10; }
  finally { await file.close(); }
}
function policyFor(input: Partial<JournalSegmentPolicy> = {}): JournalSegmentPolicy {
  const p = { ...JOURNAL_SEGMENT_POLICY, ...input };
  if (![p.segmentBytes, p.maxBytes, p.maxAgeMs].every(n => Number.isSafeInteger(n) && n > 0)
    || p.segmentBytes < 2048 || p.segmentBytes > JOURNAL_SEGMENT_POLICY.segmentBytes || p.maxBytes < p.segmentBytes * 2
    || p.maxBytes > JOURNAL_SEGMENT_POLICY.maxBytes || Math.ceil(p.maxBytes / p.segmentBytes) > MAX_SEGMENTS) invalid();
  return p;
}
export function isJournalSegmentHeader(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.name === "journal_segment" && v.schemaVersion === 1 && uuid(v.segmentId) && uint(v.sequence) && v.sequence > 0;
}
async function finishRotation(root: string, index: Index, hook?: JournalRotationOptions["afterStage"]) {
  const p = index.pending; if (!p) return;
  const sourcePath = archivePath(root, p.source.id);
  const archived = await safeStat(sourcePath).catch(e => { if (missing(e)) return null; throw e; });
  if (archived) { if (!matches(archived, p.source, true)) invalid(); }
  else {
    const source = await safeStat(activePath(root)); if (!matches(source, p.source, true)) invalid();
    await rename(activePath(root), sourcePath); await syncDirectory(root);
  }
  hook?.("renamed");
  let target = await safeStat(activePath(root)).catch(e => { if (missing(e)) return null; throw e; });
  if (!target) {
    const header = JSON.stringify({ name: "journal_segment", schemaVersion: 1, segmentId: p.nextId, sequence: p.nextSequence }) + "\n";
    const file = await open(activePath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(header); await file.sync(); } finally { await file.close(); }
    target = await safeStat(activePath(root)); await syncDirectory(root);
  } else {
    // A crash may have created the next file but not committed its identity.
    const file = await open(activePath(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = Buffer.alloc(512), result = await file.read(bytes, 0, bytes.length, 0), end = bytes.subarray(0, result.bytesRead).indexOf(10);
      if (end < 0) invalid();
      const v = JSON.parse(bytes.subarray(0, end).toString("utf8"));
      if (!isJournalSegmentHeader(v) || v.segmentId !== p.nextId || v.sequence !== p.nextSequence) invalid();
    } finally { await file.close(); }
  }
  hook?.("created");
  index.closed.push(p.source); index.active = descriptor(target, p.nextId, p.nextSequence, p.atMs);
  index.pending = null; index.revision++; await publish(root, index); hook?.("committed");
}
async function removeGarbage(root: string, index: Index) {
  if (!index.garbage.length) return;
  for (const s of index.garbage) {
    const path = archivePath(root, s.id), st = await safeStat(path).catch(e => { if (missing(e)) return null; throw e; });
    if (st) { if (!matches(st, s, true)) invalid(); await unlink(path); }
  }
  await syncDirectory(root); index.garbage = []; index.revision++; await publish(root, index);
}
async function prune(root: string, index: Index, policy: JournalSegmentPolicy, incoming: number, at: number, hook?: JournalRotationOptions["afterStage"]) {
  await removeGarbage(root, index);
  const active = await safeStat(activePath(root)); if (!matches(active, index.active)) invalid();
  let total = active.size + index.closed.reduce((n, s) => n + s.bytes, 0) + incoming;
  const victims: JournalSegment[] = [];
  for (const s of [...index.closed].sort((a, b) => a.sequence - b.sequence)) {
    const age = at >= s.createdAtMs && at - s.createdAtMs >= policy.maxAgeMs;
    if (!age && total <= policy.maxBytes && index.closed.length - victims.length < MAX_SEGMENTS - 1) continue;
    victims.push(s); total -= s.bytes;
  }
  if (total > policy.maxBytes) throw new Error("journal_segment_capacity");
  if (!victims.length) return;
  index.closed = index.closed.filter(s => !victims.includes(s)); index.garbage = victims;
  index.retiredThrough = Math.max(index.retiredThrough, ...victims.map(s => s.sequence));
  index.retiredSegments += victims.length; index.retiredBytes += victims.reduce((n, s) => n + s.bytes, 0);
  index.revision++; await publish(root, index); hook?.("retired");
  await removeGarbage(root, index);
}

/** Called immediately before append, under events.lock. Small legacy journals
 * retain their old one-file shape. Activation/rotation is crash-recoverable;
 * the append itself is never replayed by recovery. */
export async function prepareJournalAppend(root: string, incomingBytes: number, options: JournalRotationOptions = {}) {
  const policy = policyFor(options.policy), now = options.nowMs ?? Date.now();
  if (!uint(now) || now < 1 || !uint(incomingBytes) || incomingBytes > MAX_LINE_BYTES
    || incomingBytes + 256 > policy.segmentBytes) throw new Error("journal_record_capacity");
  await checkDirectory(root);
  let index = await readIndexFile(join(root, "log", INDEX));
  let st = await safeStat(activePath(root)).catch(e => { if (missing(e)) return null; throw e; });
  if (!index) {
    if (!st || st.size + incomingBytes <= policy.segmentBytes && !(await partialTail(activePath(root), st.size))) return;
    index = { schemaVersion: 1, format: FORMAT, revision: 1, active: descriptor(st, randomUUID(), 1, now),
      closed: [], garbage: [], pending: null, retiredThrough: 0, retiredSegments: 0, retiredBytes: 0 };
    await publish(root, index);
  }
  await finishRotation(root, index); await removeGarbage(root, index);
  st = await safeStat(activePath(root)); if (!matches(st, index.active)) invalid();
  if (st.size + incomingBytes > policy.segmentBytes || now >= index.active.createdAtMs + policy.maxAgeMs || await partialTail(activePath(root), st.size)) {
    // Reserve the next file header before creation; archived files are retired
    // first so even the rename/create window has a bounded data footprint.
    await prune(root, index, policy, incomingBytes + 256, now, options.afterStage);
    index.pending = { source: { ...index.active, bytes: st.size }, nextId: randomUUID(), nextSequence: index.active.sequence + 1, atMs: now };
    index.revision++; await publish(root, index); options.afterStage?.("intent");
    await finishRotation(root, index, options.afterStage);
  }
  await prune(root, index, policy, incomingBytes, now, options.afterStage);
}

export type JournalSegmentEntry = JournalSegment & { path: string; sealed: boolean };
/** Fixed, finite inventory from an owned manifest; no directory-wide glob, no
 * user paths in the protocol, and no recovery writes on queries. */
export async function inspectJournalSegments(root: string): Promise<{
  mode: "legacy" | "segmented"; entries: JournalSegmentEntry[]; revision: number; retiredThrough: number;
  retiredSegments: number; retiredBytes: number; pending: boolean; gaps: string[];
}> {
  try { await checkDirectory(root, false); } catch (e) {
    if (missing(e)) return { mode: "legacy", entries: [], revision: 0, retiredThrough: 0, retiredSegments: 0, retiredBytes: 0, pending: false, gaps: [] };
    throw e;
  }
  const index = await readIndexFile(join(root, "log", INDEX));
  if (!index) return { mode: "legacy", entries: [], revision: 0, retiredThrough: 0, retiredSegments: 0, retiredBytes: 0, pending: false, gaps: [] };
  const entries: JournalSegmentEntry[] = [], gaps: string[] = [];
  for (const s of index.closed) {
    try { const path = archivePath(root, s.id), st = await safeStat(path); if (!matches(st, s, true)) invalid(); entries.push({ ...s, path, sealed: true }); }
    catch { gaps.push("segment_unavailable"); }
  }
  if (index.pending) {
    gaps.push("rotation_in_progress");
    const s = index.pending.source;
    for (const path of [archivePath(root, s.id), activePath(root)]) {
      try { const st = await safeStat(path); if (matches(st, s, true)) { entries.push({ ...s, path, sealed: true }); break; } } catch { /* either rename boundary */ }
    }
  } else {
    try { const path = activePath(root), st = await safeStat(path); if (!matches(st, index.active)) invalid(); entries.push({ ...index.active, bytes: st.size, path, sealed: false }); }
    catch { gaps.push("active_segment_unavailable"); }
  }
  return { mode: "segmented", entries: entries.sort((a, b) => a.sequence - b.sequence), revision: index.revision,
    retiredThrough: index.retiredThrough, retiredSegments: index.retiredSegments, retiredBytes: index.retiredBytes,
    pending: index.pending !== null || index.garbage.length > 0, gaps: [...new Set(gaps)] };
}

/** Watchdog retention must not rewrite a registered active inode. Semantic
 * compaction is still the legacy path; segmented files are retired whole. */
export async function maintainSegmentedJournal(root: string, options: JournalRotationOptions = {}): Promise<boolean> {
  if (!(await readIndexFile(join(root, "log", INDEX)))) return false;
  await prepareJournalAppend(root, 0, options); return true;
}
