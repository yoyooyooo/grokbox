import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type JournalWriteResult = "written" | "unprojected" | "write_failed";
export type WriterHealth = {
  version: 1; observerId: string; pid: number; observedAt: string;
  attempted: number; written: number; unprojected: number; writeFailed: number;
  timedOut: number; dropped: number; pending: number; peakPending: number;
  lastSuccessAt: string | null; lastFailureAt: string | null;
};
const observerId = randomUUID(), MAX_ROOTS = 128, MAX_PENDING = 64;
const counters = new Map<string, { value: WriterHealth; publishing: boolean; lastPublish: number }>();
const directory = (root: string) => join(root, "state", "observability");
function state(root: string) {
  let current = counters.get(root);
  if (!current) {
    if (counters.size >= MAX_ROOTS) {
      const victim = [...counters.entries()].find(([, s]) => s.value.pending === 0 && !s.publishing);
      if (!victim) return undefined;
      counters.delete(victim[0]);
    }
    current = { value: { version: 1, observerId, pid: process.pid, observedAt: new Date().toISOString(),
      attempted: 0, written: 0, unprojected: 0, writeFailed: 0, timedOut: 0, dropped: 0, pending: 0, peakPending: 0,
      lastSuccessAt: null, lastFailureAt: null }, publishing: false, lastPublish: 0 };
    counters.set(root, current);
  }
  return current;
}
async function publish(root: string, current: NonNullable<ReturnType<typeof state>>, force = false): Promise<void> {
  if (current.publishing || (!force && Date.now() - current.lastPublish < 1000)) return;
  current.publishing = true;
  const temp = join(directory(root), `${observerId}.tmp`), dest = join(directory(root), `${observerId}.json`);
  try {
    await mkdir(directory(root), { recursive: true, mode: 0o700 });
    const handle = await open(temp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(current.value)); } finally { await handle.close(); }
    await rename(temp, dest); current.lastPublish = Date.now();
  } catch { await unlink(temp).catch(() => undefined); /* Health IO cannot fail the observed work. */ }
  finally { current.publishing = false; }
}
/** Bounded local bookkeeping; diagnostics do not acquire execution authority. */
export async function observeJournalWrite(root: string, write: () => Promise<JournalWriteResult>): Promise<JournalWriteResult> {
  const current = state(root);
  if (!current) return "write_failed";
  const h = current.value; h.attempted++; h.observedAt = new Date().toISOString();
  if (h.pending >= MAX_PENDING) {
    h.dropped++; h.lastFailureAt = h.observedAt; await publish(root, current, true); return "write_failed";
  }
  h.pending++; h.peakPending = Math.max(h.peakPending, h.pending);
  let result: JournalWriteResult;
  try { result = await write(); } catch { result = "write_failed"; }
  finally { h.pending--; }
  h.observedAt = new Date().toISOString();
  if (result === "written") { h.written++; h.lastSuccessAt = h.observedAt; }
  else { if (result === "unprojected") h.unprojected++; else h.writeFailed++; h.lastFailureAt = h.observedAt; }
  await publish(root, current, result !== "written");
  return result;
}
export function noteJournalObservationTimeout(root: string): void {
  const current = state(root); if (!current) return;
  current.value.timedOut++; current.value.observedAt = current.value.lastFailureAt = new Date().toISOString();
  void publish(root, current, true);
}
/** In-process diagnostics are useful even when the secondary file cannot be written. */
export function journalWriterHealth(root: string): WriterHealth | undefined {
  const h = counters.get(root)?.value; return h ? { ...h } : undefined;
}
function project(value: unknown): WriterHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.observerId !== "string" || !/^[a-f0-9-]{36}$/.test(v.observerId) || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0) return undefined;
  if (typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt))) return undefined;
  const out = { version: 1 as const, observerId: v.observerId, pid: Number(v.pid), observedAt: v.observedAt } as WriterHealth;
  for (const key of ["attempted", "written", "unprojected", "writeFailed", "timedOut", "dropped", "pending", "peakPending"] as const) {
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0) return undefined;
    out[key] = Number(v[key]);
  }
  for (const key of ["lastSuccessAt", "lastFailureAt"] as const) {
    if (v[key] !== null && (typeof v[key] !== "string" || !Number.isFinite(Date.parse(v[key])))) return undefined;
    out[key] = v[key] as string | null;
  }
  return out;
}
export type JournalHealthObservation = { state: "present" | "not_instrumented" | "partial" | "unavailable"; writers: WriterHealth[]; truncated: boolean; liveness: "not_proven" };
/** Independent read-only health channel. Old files are evidence, not proof of a live PID. */
export async function observeJournalHealth(root: string): Promise<JournalHealthObservation> {
  const result: JournalHealthObservation = { state: "present", writers: [], truncated: false, liveness: "not_proven" };
  let files: string[];
  try { files = (await readdir(directory(root))).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).sort(); }
  catch (error) { result.state = error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? "not_instrumented" : "unavailable"; return result; }
  result.truncated = files.length > 32;
  if (result.truncated) result.state = "partial";
  for (const name of files.slice(-32)) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(directory(root), name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 8192) { result.state = "partial"; continue; }
      const value = project(JSON.parse(await handle.readFile("utf8")));
      if (value) result.writers.push(value); else result.state = "partial";
    } catch { result.state = "partial"; }
    finally { await handle?.close().catch(() => undefined); }
  }
  return result;
}
