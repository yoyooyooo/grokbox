import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type JournalWriterRole = "host" | "modeld" | "control";
export type JournalWriteFailure = "EACCES" | "EPERM" | "ENOSPC" | "EROFS" | "EIO" | "LOCK_TIMEOUT" | "UNKNOWN";
export type JournalWriterHealth = {
  version: 1; instance: string; pid: number; role: JournalWriterRole | "legacy";
  observedAt: string;
  attempted: number; written: number; failed: number; unprojected: number;
  timedOut: number; dropped: number; lastFailureAt: string | null;
  pending: number; peakPending: number; observerFailures?: number; healthWriteFailures?: number;
  lastAttemptAt: string | null; lastWrittenAt: string | null; lastFailure: JournalWriteFailure | null;
};
const INSTANCE = randomUUID();
const MAX_CACHED_ROOTS = 32;
// A concurrent observation backlog budget, never an execution/request quota.
const MAX_PENDING = 64;
const COUNTER_MAX = 1_000_000_000;
const roles: JournalWriterRole[] = ["host", "modeld", "control"];
const failures: JournalWriteFailure[] = ["EACCES", "EPERM", "ENOSPC", "EROFS", "EIO", "LOCK_TIMEOUT", "UNKNOWN"];
type Entry = { value: JournalWriterHealth; persistedAt: number; writing: boolean };
const entries = new Map<string, Entry>();
const healthDirectory = (root: string) => join(root, "state", "journal-health");
const bump = (n: number) => Math.min(COUNTER_MAX, n + 1);
function entry(root: string, role: JournalWriterRole): Entry {
  const key = JSON.stringify([root, role]);
  let found = entries.get(key);
  if (!found) {
    if (entries.size >= MAX_CACHED_ROOTS) {
      const idle = [...entries].find(([, value]) => value.value.pending === 0 && !value.writing);
      if (idle) entries.delete(idle[0]);
    }
    found = { persistedAt: 0, writing: false, value: {
      version: 1, instance: INSTANCE, pid: process.pid, role, observedAt: new Date().toISOString(),
      attempted: 0, written: 0, failed: 0, unprojected: 0, timedOut: 0, dropped: 0, lastFailureAt: null, pending: 0, peakPending: 0,
      observerFailures: 0, healthWriteFailures: 0, lastAttemptAt: null, lastWrittenAt: null, lastFailure: null,
    } };
    entries.set(key, found);
  }
  return found;
}
function classify(error: unknown): JournalWriteFailure {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return failures.includes(code as JournalWriteFailure) ? code as JournalWriteFailure : "UNKNOWN";
  } catch { return "UNKNOWN"; }
}
/** A separate, atomic health snapshot, not another event in the failing journal.
 * No timer or background queue: the existing append operation owns this bounded
 * best-effort write. Failure never changes inference or grants repair authority. */
async function persist(root: string, record: Entry, force: boolean): Promise<void> {
  const now = Date.now();
  if (record.writing || (!force && now - record.persistedAt < 1000)) return;
  record.writing = true;
  const directory = healthDirectory(root);
  const path = join(directory, `${record.value.role}-${process.pid}-${INSTANCE}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    record.value.observedAt = new Date().toISOString();
    await handle.writeFile(`${JSON.stringify(record.value)}\n`);
    await handle.close(); handle = undefined;
    await rename(tmp, path);
    record.persistedAt = now;
  } catch { record.value.healthWriteFailures = bump(record.value.healthWriteFailures ?? 0); }
  finally {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    record.writing = false;
  }
}
export function noteUnprojectedJournalEvent(root: string, role: JournalWriterRole): void {
  const record = entry(root, role);
  record.value.unprojected = bump(record.value.unprojected);
  // An invalid event has zero filesystem effects; the next valid append flushes
  // this counter. Readers never infer health from absence of a snapshot.
}
export function noteJournalObserverFailure(root: string, role: JournalWriterRole): void {
  const record = entry(root, role);
  record.value.observerFailures = bump(record.value.observerFailures ?? 0);
  record.persistedAt = 0;
}
export type JournalWriteCompletion = ((error?: unknown, outcome?: "written" | "unprojected") => Promise<void>) & { accepted: boolean };
export function startJournalWrite(root: string, role: JournalWriterRole): JournalWriteCompletion {
  const record = entry(root, role);
  record.value.attempted = bump(record.value.attempted);
  record.value.lastAttemptAt = new Date().toISOString();
  if (record.value.pending >= MAX_PENDING) {
    record.value.dropped = bump(record.value.dropped);
    record.value.lastFailureAt = record.value.lastAttemptAt;
    return Object.assign(async () => { await persist(root, record, true); }, { accepted: false });
  }
  record.value.pending = bump(record.value.pending);
  record.value.peakPending = Math.max(record.value.peakPending, record.value.pending);
  record.value.lastAttemptAt = new Date().toISOString();
  let settled = false;
  return Object.assign(async (error?: unknown, outcome: "written" | "unprojected" = "written") => {
    if (settled) return;
    settled = true;
    record.value.pending = Math.max(0, record.value.pending - 1);
    if (error === undefined && outcome === "written") {
      record.value.written = bump(record.value.written);
      record.value.lastWrittenAt = new Date().toISOString();
    } else if (outcome === "unprojected") {
      record.value.unprojected = bump(record.value.unprojected);
      record.value.lastFailureAt = new Date().toISOString();
    } else {
      record.value.failed = bump(record.value.failed);
      record.value.lastFailure = classify(error);
      record.value.lastFailureAt = new Date().toISOString();
    }
    await persist(root, record, error !== undefined || outcome === "unprojected");
  }, { accepted: true });
}
/** Process-local diagnostic, including a health-snapshot write failure. */
export function currentJournalWriterHealth(root: string, role: JournalWriterRole): JournalWriterHealth {
  return { ...entry(root, role).value };
}
const isTime = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
function project(value: unknown): JournalWriterHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.instance !== "string" || !/^[a-f0-9-]{36}$/.test(v.instance)
    || !Number.isSafeInteger(v.pid) || (v.pid as number) <= 0 || !roles.includes(v.role as JournalWriterRole) || !isTime(v.observedAt)) return undefined;
  const out: Record<string, unknown> = { version: 1, instance: v.instance, pid: v.pid, role: v.role, observedAt: v.observedAt };
  for (const key of ["attempted", "written", "failed", "unprojected", "pending", "peakPending", "observerFailures", "healthWriteFailures", "timedOut", "dropped"]) {
    if (typeof v[key] !== "number" || !Number.isSafeInteger(v[key]) || v[key] < 0 || v[key] > COUNTER_MAX) return undefined;
    out[key] = v[key];
  }
  for (const key of ["lastAttemptAt", "lastWrittenAt", "lastFailureAt"]) {
    if (v[key] !== null && !isTime(v[key])) return undefined;
    out[key] = v[key];
  }
  if (v.lastFailure !== null && !failures.includes(v.lastFailure as JournalWriteFailure)) return undefined;
  out.lastFailure = v.lastFailure;
  return out as JournalWriterHealth;
}
export type JournalHealthObservation = {
  state: "present" | "partial" | "missing" | "unavailable" | "not_instrumented";
  writers: JournalWriterHealth[];
  truncated: boolean;
  meaning: "writer-snapshots-not-liveness-or-admission";
  liveness?: "not_proven";
};
/** Pure read. Stale/PID-reused process snapshots are identified by instance and
 * observedAt; they are never presented as evidence that a current writer is live. */
export async function readJournalHealth(root: string): Promise<JournalHealthObservation> {
  const result: JournalHealthObservation = { state: "missing", writers: [], truncated: false, meaning: "writer-snapshots-not-liveness-or-admission" };
  const names: string[] = [];
  try {
    const directory = await opendir(healthDirectory(root));
    let scanned = 0;
    for await (const item of directory) {
      if (++scanned > 512) { result.truncated = true; break; }
      if (/^(host|modeld|control)-[0-9]+-[a-f0-9-]{36}\.json$/.test(item.name)) {
        names.push(item.name);
        if (names.length > 64) { result.truncated = true; break; }
      }
    }
  }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) result.state = "unavailable";
    return result;
  }
  const candidates = names.filter(name => /^(host|modeld|control)-[0-9]+-[a-f0-9-]{36}\.json$/.test(name));
  result.truncated ||= candidates.length > 64;
  let invalid = false;
  for (const name of candidates.slice(-64)) {
    let handle;
    try {
      handle = await open(join(healthDirectory(root), name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) { invalid = true; continue; }
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) { invalid = true; continue; }
      const value = project(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (value) result.writers.push(value); else invalid = true;
    } catch { invalid = true; }
    finally { await handle?.close().catch(() => undefined); }
  }
  result.writers.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (result.writers.length > 16) { result.writers.length = 16; result.truncated = true; }
  result.state = invalid || result.truncated ? "partial" : result.writers.length > 0 ? "present" : "missing";
  return result;
}


/** Compatibility with pre-observability WIP call sites (HEAD ledger/stream path). */
export type JournalWriteResult = "written" | "unprojected" | "write_failed";
export type WriterHealth = JournalWriterHealth & {
  observerId: string; writeFailed: number; timedOut: number; dropped: number;
  lastSuccessAt: string | null; lastFailureAt: string | null;
};

export async function observeJournalWrite(root: string, write: () => Promise<JournalWriteResult>, role: JournalWriterRole = "host"): Promise<JournalWriteResult> {
  const done = startJournalWrite(root, role);
  if (!done.accepted) { await done(); return "write_failed"; }
  try {
    const result = await write();
    await done(result === "write_failed" ? new Error("write_failed") : undefined, result === "unprojected" ? "unprojected" : "written");
    return result;
  } catch (error) {
    await done(error);
    return "write_failed";
  }
}

export function noteJournalObservationTimeout(root: string, role: JournalWriterRole = "host"): void {
  const record = entry(root, role);
  record.value.timedOut = bump(record.value.timedOut);
  record.value.lastFailureAt = new Date().toISOString();
  record.persistedAt = 0;
}

export function journalWriterHealth(root: string): WriterHealth | undefined {
  const h = currentJournalWriterHealth(root, "host");
  return {
    ...h,
    observerId: h.instance,
    writeFailed: h.failed,
    timedOut: h.timedOut,
    dropped: h.dropped,
    lastSuccessAt: h.lastWrittenAt,
    lastFailureAt: h.lastFailureAt,
  };
}

/** Read the previously shipped process-wide snapshots only when the new
 * role-aware directory is absent. Missing legacy counters stay absent; a
 * successful read cannot invent a known writer role or current liveness. */
async function readLegacyJournalHealth(root: string): Promise<JournalHealthObservation> {
  const result: JournalHealthObservation = { state: "missing", writers: [], truncated: false,
    meaning: "writer-snapshots-not-liveness-or-admission", liveness: "not_proven" };
  const directory = join(root, "state", "observability");
  try {
    let scanned = 0;
    for await (const item of await opendir(directory)) {
      if (++scanned > 512 || result.writers.length >= 32) { result.truncated = true; break; }
      if (!/^[a-f0-9-]{36}\.json$/.test(item.name)) continue;
      let handle;
      try {
        handle = await open(join(directory, item.name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8192) { result.state = "partial"; continue; }
        const bytes = Buffer.alloc(8193), read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 8192) { result.state = "partial"; continue; }
        const raw = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
        const counterKeys = ["attempted", "written", "unprojected", "writeFailed", "timedOut", "dropped", "pending", "peakPending"];
        if (!raw || raw.version !== 1 || typeof raw.observerId !== "string" || !/^[a-f0-9-]{36}$/.test(raw.observerId)
          || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || !isTime(raw.observedAt)
          || counterKeys.some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 0)
          || ["lastSuccessAt", "lastFailureAt"].some(key => raw[key] !== null && !isTime(raw[key]))) {
          result.state = "partial"; continue;
        }
        result.writers.push({ version: 1, instance: raw.observerId, pid: raw.pid, role: "legacy", observedAt: raw.observedAt,
          attempted: raw.attempted, written: raw.written, failed: raw.writeFailed, unprojected: raw.unprojected,
          timedOut: raw.timedOut, dropped: raw.dropped, pending: raw.pending, peakPending: raw.peakPending,
          lastAttemptAt: null, lastWrittenAt: raw.lastSuccessAt, lastFailureAt: raw.lastFailureAt,
          lastFailure: raw.writeFailed > 0 ? "UNKNOWN" : null });
      } catch { result.state = "partial"; }
      finally { await handle?.close().catch(() => undefined); }
    }
    result.writers.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    if (result.truncated) result.state = "partial";
    else if (result.state !== "partial" && result.writers.length) result.state = "present";
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) result.state = "unavailable";
  }
  return result;
}
export async function observeJournalHealth(root: string): Promise<JournalHealthObservation> {
  const current = await readJournalHealth(root);
  const read = current.state === "missing" ? await readLegacyJournalHealth(root) : current;
  return { ...read, state: read.state === "missing" ? "not_instrumented" : read.state, liveness: "not_proven" };
}
