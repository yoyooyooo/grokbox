import { constants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { OBSERVATION_RETENTION } from "@grokbox/runtime-kernel/observation";
import { DiagnosticBudgetError, withDiagnosticAdmission } from "../host/diagnostic-budget.node.ts";

/** Writer-owned diagnostic segments. The caller must already own the modeld
 * listener; a borrower or failed competing acquisition must not open this sink.
 * This is NOT a raw stdout/exception/body collector or an execution ledger. */
export type ProcessLogPolicy = { segmentBytes: number; maxBytes: number; maxAgeMs: number };
export type ProcessLogEvent = "ready" | "listener_failed" | "shutdown_requested";
export type ProcessLogHealth = {
  state: "available" | "unavailable" | "closed";
  writtenRecords: number; droppedRecords: number; rotations: number;
  reason: "none" | "invalid_record" | "writer_busy" | "storage_unavailable" | "storage_pressure";
};
const POLICY: ProcessLogPolicy = {
  segmentBytes: OBSERVATION_RETENTION.processSegmentBytes,
  maxBytes: OBSERVATION_RETENTION.processMaxBytes,
  maxAgeMs: OBSERVATION_RETENTION.journalMaxAgeMs,
};
const MAX_RECORD = 1024, MAX_HEADER = 512, MAX_SLOTS = 64;
const FORMAT = "grokbox.modeld-process-log";
const own = (v: unknown, k: string): unknown => {
  if (v === null || typeof v !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(v, k)?.value; } catch { return undefined; }
};
const validTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const validGeneration = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function policyFor(input: Partial<ProcessLogPolicy> = {}): ProcessLogPolicy {
  const p = { ...POLICY, ...input };
  if (![p.segmentBytes, p.maxBytes, p.maxAgeMs].every(n => Number.isSafeInteger(n) && n > 0)
    || p.segmentBytes < 2048 || p.segmentBytes > POLICY.segmentBytes
    || p.maxBytes < 2 * p.segmentBytes || Math.floor(p.maxBytes / p.segmentBytes) > MAX_SLOTS
    || p.maxBytes > POLICY.maxBytes) throw new Error("process_log_invalid_policy");
  return p;
}
const directoryFor = (root: string) => join(root, "log", "process");
const segmentName = (slot: number) => `modeld.${String(slot).padStart(3, "0")}.ndjson`;
const missing = (e: unknown) => own(e, "code") === "ENOENT";
async function privateDirectory(path: string, create: boolean) {
  if (create) await mkdir(path, { recursive: false, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0
    || (process.getuid && st.uid !== process.getuid())) throw new Error("process_log_unsafe_directory");
}
async function ensurePrivateDirectory(path: string) {
  try { await privateDirectory(path, true); }
  catch (e) { if (own(e, "code") !== "EEXIST") throw e; await privateDirectory(path, false); }
}
type Segment = { slot: number; sequence: number; generation: string; createdAtMs: number; bytes: number; dev: number; ino: number };
async function inspectSegment(dir: string, slot: number): Promise<Segment | null> {
  const path = join(dir, segmentName(slot));
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new Error("process_log_unsafe_segment");
    const bytes = Buffer.alloc(MAX_HEADER);
    const read = await file.read(bytes, 0, bytes.length, 0), end = bytes.subarray(0, read.bytesRead).indexOf(10);
    if (end < 0) throw new Error("process_log_invalid_header");
    const header: unknown = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    const sequence = own(header, "sequence"), generation = own(header, "generation"), createdAtMs = own(header, "createdAtMs");
    if (own(header, "format") !== FORMAT || own(header, "schemaVersion") !== 1
      || !Number.isSafeInteger(sequence) || Number(sequence) < 1 || !validGeneration(generation) || !validTime(createdAtMs)) throw new Error("process_log_invalid_header");
    const after = await lstat(path);
    if (after.dev !== st.dev || after.ino !== st.ino || after.isSymbolicLink()) throw new Error("process_log_segment_changed");
    return { slot, sequence: Number(sequence), generation, createdAtMs, bytes: st.size, dev: st.dev, ino: st.ino };
  } catch (e) { if (missing(e)) return null; throw e; }
  finally { await file?.close(); }
}
async function removeSegment(dir: string, segment: Segment) {
  const path = join(dir, segmentName(segment.slot)), current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || current.dev !== segment.dev || current.ino !== segment.ino || current.size !== segment.bytes) throw new Error("process_log_segment_changed");
  await unlink(path);
}
function encodeRecord(input: unknown, generation: string): Buffer | null {
  const event = own(input, "event"), atMs = own(input, "atMs");
  if (!validTime(atMs) || !["ready", "listener_failed", "shutdown_requested"].includes(typeof event === "string" ? event : "")) return null;
  // No arbitrary message, stack, cause, endpoint, model name or extra fields.
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "modeld_process_event", generation, event, atMs }) + "\n");
  return bytes.length <= MAX_RECORD ? bytes : null;
}
export type ProcessLogMaintenance = { state: "maintained" | "busy" | "unavailable"; reclaimedBytes: number; activeSegmentPreserved: true };
export type BoundedProcessLog = {
  maintain: (nowMs: number) => Promise<ProcessLogMaintenance>;
  append: (input: unknown) => Promise<"written" | "dropped" | "unavailable">;
  close: () => Promise<void>;
  health: () => ProcessLogHealth;
};

export async function openBoundedProcessLog(input: { runRoot: string; generation: string; nowMs: number; configurationRoot?: string; policy?: Partial<ProcessLogPolicy> }): Promise<BoundedProcessLog> {
  const policy = policyFor(input.policy);
  if (!validGeneration(input.generation) || !validTime(input.nowMs)) throw new Error("process_log_invalid_identity");
  // The existing listener owner creates the run root. Never follow a symlink to
  // an unrelated tree or recursively repair permissions of user-owned paths.
  const root = await lstat(input.runRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid())) throw new Error("process_log_unsafe_root");
  await ensurePrivateDirectory(join(input.runRoot, "log"));
  const dir = directoryFor(input.runRoot); await ensurePrivateDirectory(dir);
  const slots = Math.floor(policy.maxBytes / policy.segmentBytes);
  const found: Segment[] = [];
  // Fixed bounded inventory. A policy reduction must not ignore older slots.
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const segment = await inspectSegment(dir, slot);
    if (segment) found.push(segment);
  }
  if (new Set(found.map(s => s.sequence)).size !== found.length) throw new Error("process_log_conflicting_sequence");
  let sequence = Math.max(0, ...found.map(s => s.sequence));
  let current: Segment | undefined, handle: FileHandle | undefined, busy = false;
  const health: ProcessLogHealth = { state: "available", writtenRecords: 0, droppedRecords: 0, rotations: 0, reason: "none" };
  async function syncDirectory() {
    const d = await open(dir, constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
  }
  async function rotate(atMs: number) {
    await handle?.sync(); await handle?.close(); handle = undefined; current = undefined;
    // These segments belong to completed/previous writers, or this writer's now
    // closed segment. No active fd is truncated or renamed behind the writer.
    const expired = found.filter(s => s.slot >= slots || s.bytes > policy.segmentBytes
      || (atMs >= s.createdAtMs && atMs - s.createdAtMs >= policy.maxAgeMs));
    for (const segment of expired) { await removeSegment(dir, segment); found.splice(found.indexOf(segment), 1); }
    if (found.length >= slots) {
      const oldest = [...found].sort((a, b) => a.sequence - b.sequence)[0]!;
      await removeSegment(dir, oldest); found.splice(found.indexOf(oldest), 1);
    }
    const slot = Array.from({ length: slots }, (_, i) => i).find(i => !found.some(s => s.slot === i));
    if (slot === undefined || !Number.isSafeInteger(++sequence)) throw new Error("process_log_sequence_exhausted");
    const path = join(dir, segmentName(slot));
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const header = Buffer.from(JSON.stringify({ schemaVersion: 1, format: FORMAT, generation: input.generation, sequence, createdAtMs: atMs }) + "\n");
    await handle.writeFile(header); await handle.sync();
    const st = await handle.stat();
    current = { slot, sequence, generation: input.generation, createdAtMs: atMs, bytes: header.length, dev: st.dev, ino: st.ino };
    found.push(current); await syncDirectory(); health.rotations++;
  }
  const admit = <T>(run: () => Promise<T>, maxBytes = 16 * 1024, maintenance = false) => input.configurationRoot
    ? withDiagnosticAdmission({ configurationRoot: input.configurationRoot, sourceRoot: input.runRoot, writer: "process", maxBytes, maintenance }, run) : run();
  // Always start a new segment: a prior hard crash may have left a partial tail,
  // which must never be joined to a new record to manufacture valid NDJSON.
  try { await admit(() => rotate(input.nowMs)); } catch (e) { await handle?.close().catch(() => undefined); throw e; }
  return {
    health: () => ({ ...health }),
    maintain: async nowMs => {
      const result = (state: ProcessLogMaintenance["state"], reclaimedBytes = 0): ProcessLogMaintenance => ({ state, reclaimedBytes, activeSegmentPreserved: true });
      if (!validTime(nowMs) || health.state !== "available") return result("unavailable");
      if (busy) return result("busy");
      busy = true;
      let reclaimed = 0;
      try {
        // Only this listener owner's writer can retire its closed descriptors.
        // Never rotate/create a new active file merely because the service idles.
        await admit(async () => {
          for (const segment of [...found]) {
            if (segment === current || nowMs < segment.createdAtMs || nowMs - segment.createdAtMs < policy.maxAgeMs) continue;
            await removeSegment(dir, segment); found.splice(found.indexOf(segment), 1); reclaimed += segment.bytes;
          }
          if (reclaimed) await syncDirectory();
        }, 0, true);
        return result("maintained", reclaimed);
      } catch {
        health.state = "unavailable"; health.reason = "storage_unavailable";
        return result("unavailable", reclaimed);
      } finally { busy = false; }
    },
    append: async value => {
      if (health.state !== "available") return "unavailable";
      const record = encodeRecord(value, input.generation);
      if (!record) { health.droppedRecords++; health.reason = "invalid_record"; return "dropped"; }
      if (busy) { health.droppedRecords++; health.reason = "writer_busy"; return "dropped"; }
      busy = true;
      try {
        return await admit(async () => {
        const atMs = Number(own(value, "atMs"));
        if (!current || current.bytes + record.length > policy.segmentBytes
          || (atMs >= current.createdAtMs && atMs - current.createdAtMs >= policy.maxAgeMs)) await rotate(atMs);
        const st = await lstat(join(dir, segmentName(current!.slot)));
        if (st.dev !== current!.dev || st.ino !== current!.ino || st.isSymbolicLink() || st.nlink !== 1 || st.size !== current!.bytes) throw new Error("process_log_segment_changed");
        await handle!.writeFile(record); await handle!.sync(); current!.bytes += record.length;
        health.writtenRecords++; return "written" as const;
        });
      } catch (error) {
        if (error instanceof DiagnosticBudgetError && (error.reason === "pressure" || error.reason === "busy")) {
          health.reason = error.reason === "busy" ? "writer_busy" : "storage_pressure"; health.droppedRecords++;
          return "dropped";
        }
        health.state = "unavailable"; health.reason = "storage_unavailable"; health.droppedRecords++;
        return "unavailable";
      } finally { busy = false; }
    },
    close: async () => {
      // The scoped caller settles append before release; no detached write queue.
      if (busy) throw new Error("process_log_write_not_settled");
      const owned = handle; handle = undefined;
      try { await owned?.close(); } finally { health.state = "closed"; }
    },
  };
}

/** Pure filesystem snapshot of owned segment names; no mkdir, repair or GC.
 * Legacy raw modeld-process.log is counted separately and is never auto-deleted. */
export async function observeProcessLogStorage(runRoot: string) {
  const segments: Array<{ sequence: number; bytes: number; createdAtMs: number }> = [];
  let state: "available" | "missing" | "unavailable" = "available";
  try {
    await privateDirectory(join(runRoot, "log"), false); await privateDirectory(directoryFor(runRoot), false);
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const segment = await inspectSegment(directoryFor(runRoot), slot);
      if (segment) segments.push({ sequence: segment.sequence, bytes: segment.bytes, createdAtMs: segment.createdAtMs });
    }
  } catch (e) { state = missing(e) ? "missing" : "unavailable"; }
  let legacyBytes: number | null = null;
  try {
    const legacy = await lstat(join(runRoot, "log", "modeld-process.log"));
    if (legacy.isFile() && !legacy.isSymbolicLink() && legacy.nlink === 1) legacyBytes = legacy.size;
  } catch (e) { if (missing(e)) legacyBytes = 0; }
  return { scope: "owned_modeld_process_segments" as const, state, bytes: segments.reduce((n, s) => n + s.bytes, 0),
    maxBytes: POLICY.maxBytes, segmentBytes: POLICY.segmentBytes, segments: segments.sort((a, b) => a.sequence - b.sequence),
    legacyRawFileBytes: legacyBytes, legacyFileManaged: false, rawStdioCaptured: false };
}
