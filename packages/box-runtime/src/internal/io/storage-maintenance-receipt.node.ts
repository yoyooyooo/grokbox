import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CONTINUITY_STORAGE_OWNERS, ownedMaintenanceReceipt } from "@grokbox/runtime-kernel/observation";
import { monitorProcessIdentity } from "./monitor-owner.node.ts";
import { STORAGE_MAINTENANCE_INTERVAL_MS, type StorageMaintenanceCycle } from "./storage-maintenance.node.ts";

const FORMAT = "grokbox.storage-maintenance", MAX_BYTES = 16 * 1024;
const FILE = "storage-maintenance.json", TEMP = "storage-maintenance.next.json";
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const missing = (e: unknown) => e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const invalid = (): never => { throw new Error("storage_maintenance_receipt_invalid"); };
const rootIdentity = (durable: string, run: string) => sha256Text(canonicalJson(["storage-maintenance-v1", resolve(durable), resolve(run)]));

type Receipt = { schemaVersion: 1; format: typeof FORMAT; rootId: string; serviceEpoch: string;
  pid: number; start: string | null; sequence: number; state: "running" | "stopped"; updatedAtMs: number;
  lastCycle: StorageMaintenanceCycle | null; lastSuccessAtMs: number | null; cycleFailure: boolean };

/** Never export arbitrary persisted keys, even from a damaged/local record. */
function cycle(value: unknown): StorageMaintenanceCycle | null {
  if (!row(value) || !num(value.atMs) || !num(value.elapsedMs) || typeof value.budgetExceeded !== "boolean"
    || !["completed", "partial", "configuration_unavailable"].includes(String(value.state)) || !(value.policyRevision === null || hash(value.policyRevision))) return null;
  const m = value.monitor, p = value.processLog;
  if (!row(m) || !["maintained", "busy", "not_initialized", "migration_required", "unavailable", "not_checked"].includes(String(m.state))
    || !num(m.removedEvidence) || !num(m.expiredSnapshots) || !(m.physicalBytes === null || num(m.physicalBytes))
    || !(m.clockState === null || ["observed", "clock_reversed", "clock_jump"].includes(String(m.clockState)))
    || !row(p) || !["maintained", "busy", "unavailable", "not_owned", "policy_changed", "not_checked"].includes(String(p.state))
    || !num(p.reclaimedBytes) || p.activeSegmentPreserved !== true || !Array.isArray(value.journals) || value.journals.length > 2) return null;
  const journals: StorageMaintenanceCycle["journals"] = [];
  for (const j of value.journals) {
    if (!row(j) || !["control", "host"].includes(String(j.source)) || !["maintained", "not_segmented", "busy", "unavailable"].includes(String(j.state))
      || !num(j.reclaimedBytes) || !num(j.elapsedMs)) return null;
    journals.push({ source: j.source as "control" | "host", state: j.state as typeof journals[number]["state"], reclaimedBytes: j.reclaimedBytes, elapsedMs: j.elapsedMs });
  }
  const continuity: NonNullable<StorageMaintenanceCycle["continuity"]> = [];
  if (value.continuity !== undefined) {
    if (!Array.isArray(value.continuity) || value.continuity.length !== 2) return null;
    try {
      for (const [i, item] of value.continuity.entries()) {
        const owner = CONTINUITY_STORAGE_OWNERS[i]!;
        if (!row(item) || item.owner !== owner || !["unmeasured", "unavailable", "observed"].includes(String(item.state))) return null;
        if (item.state === "observed") continuity.push({ owner, state: "observed", receipt: ownedMaintenanceReceipt(item.receipt, owner) });
        else { if (item.receipt !== null) return null; continuity.push({ owner, state: item.state as "unmeasured" | "unavailable", receipt: null }); }
      }
    } catch { return null; }
  }
  return { ...(value.continuity !== undefined ? { continuity } : {}), atMs: value.atMs, elapsedMs: value.elapsedMs, budgetExceeded: value.budgetExceeded,
    state: value.state as StorageMaintenanceCycle["state"], policyRevision: value.policyRevision as string | null,
    monitor: { state: m.state as StorageMaintenanceCycle["monitor"]["state"], removedEvidence: m.removedEvidence, expiredSnapshots: m.expiredSnapshots,
      physicalBytes: m.physicalBytes as number | null, clockState: m.clockState as string | null }, journals,
    processLog: { state: p.state, reclaimedBytes: p.reclaimedBytes, activeSegmentPreserved: true } as StorageMaintenanceCycle["processLog"] };
}
function parse(value: unknown): Receipt {
  if (!row(value) || value.schemaVersion !== 1 || value.format !== FORMAT || !hash(value.rootId) || !uuid(value.serviceEpoch)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || !(value.start === null || hash(value.start))
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || !num(value.updatedAtMs)
    || !["running", "stopped"].includes(String(value.state)) || typeof value.cycleFailure !== "boolean"
    || !(value.lastSuccessAtMs === null || num(value.lastSuccessAtMs))) return invalid();
  const lastCycle = value.lastCycle === null ? null : cycle(value.lastCycle);
  if (lastCycle === null && value.lastCycle !== null) return invalid();
  return { schemaVersion: 1, format: FORMAT, rootId: value.rootId, serviceEpoch: value.serviceEpoch,
    pid: Number(value.pid), start: value.start as string | null, sequence: Number(value.sequence), state: value.state as Receipt["state"],
    updatedAtMs: value.updatedAtMs, lastCycle, lastSuccessAtMs: value.lastSuccessAtMs as number | null, cycleFailure: value.cycleFailure };
}
async function directory(runRoot: string, create = false) {
  const root = await lstat(runRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || process.getuid && root.uid !== process.getuid()) return invalid();
  const path = join(runRoot, "log");
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e; } }
  const dir = await lstat(path);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || process.getuid && dir.uid !== process.getuid()) return invalid();
  return path;
}
async function read(path: string): Promise<{ value: Receipt; bytes: number; dev: number; ino: number } | null> {
  let fd;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fd.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || (st.mode & 0o077) !== 0 || process.getuid && st.uid !== process.getuid()) return invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1); let used = 0;
    while (used < bytes.length) { const r = await fd.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
    if (used !== st.size || used > MAX_BYTES) return invalid();
    return { value: parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)))), bytes: st.size, dev: st.dev, ino: st.ino };
  } catch (e) { if (missing(e)) return null; throw e; }
  finally { await fd?.close(); }
}

/** Only the already-acquired modeld listener owner creates this recorder. It is
 * observation, not a config applied receipt, liveness lease or execution ledger.
 * Two fixed slots bound crash residue. Unrecognized staging data is preserved. */
export async function createStorageMaintenanceRecorder(input: { durableRoot: string; runRoot: string; serviceEpoch: string }) {
  if (!uuid(input.serviceEpoch)) return invalid();
  const dir = await directory(input.runRoot, true), rootId = rootIdentity(input.durableRoot, input.runRoot);
  const self = await monitorProcessIdentity(process.pid);
  let sequence = 0, lastCycle: StorageMaintenanceCycle | null = null, lastSuccessAtMs: number | null = null, cycleFailure = false;
  async function write(state: Receipt["state"], atMs: number) {
    await directory(input.runRoot);
    const path = join(dir, FILE), temp = join(dir, TEMP);
    const previous = await read(path);
    if (previous && previous.value.rootId !== rootId) return invalid();
    const staged = await read(temp);
    if (staged) {
      if (staged.value.rootId !== rootId) return invalid();
      const current = await lstat(temp); if (current.dev !== staged.dev || current.ino !== staged.ino || current.isSymbolicLink()) return invalid();
      await unlink(temp);
    }
    const record = parse({ schemaVersion: 1, format: FORMAT, rootId, serviceEpoch: input.serviceEpoch, pid: process.pid,
      start: self.state === "present" ? self.start : null, sequence, state, updatedAtMs: atMs, lastCycle, lastSuccessAtMs, cycleFailure });
    const bytes = Buffer.from(JSON.stringify(record) + "\n"); if (bytes.length > MAX_BYTES) return invalid();
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const current = await read(path);
    if (previous ? !current || current.dev !== previous.dev || current.ino !== previous.ino : current !== null) return invalid();
    await rename(temp, path);
    const d = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await d.sync(); } finally { await d.close(); }
  }
  return {
    record: async (value: StorageMaintenanceCycle | null) => {
      if (value && !cycle(value)) return invalid();
      lastCycle = value; cycleFailure = value === null; sequence = Math.min(Number.MAX_SAFE_INTEGER, sequence + 1);
      if (value?.state === "completed") lastSuccessAtMs = Date.now();
      await write("running", Date.now());
    },
    stop: () => write("stopped", Date.now()),
  };
}

export async function observeStorageMaintenance(input: { durableRoot: string; runRoot: string; nowMs?: number }) {
  try {
    const dir = await directory(input.runRoot), stored = await read(join(dir, FILE));
    if (!stored) return { state: "not_observed" as const, fileBytes: 0, maxFileBytes: MAX_BYTES, createsServices: false };
    const value = stored.value;
    if (value.rootId !== rootIdentity(input.durableRoot, input.runRoot)) return invalid();
    const live = await monitorProcessIdentity(value.pid), now = input.nowMs ?? Date.now();
    const owner = live.state === "missing" ? "absent" : live.state !== "present" || value.start === null ? "unavailable"
      : live.start === value.start ? "matched" : "changed";
    const age = now >= value.updatedAtMs ? now - value.updatedAtMs : null;
    const state = value.state === "stopped" ? "stopped" : owner === "absent" || owner === "changed" ? "interrupted"
      : owner !== "matched" ? "unavailable" : age === null || age > 2 * STORAGE_MAINTENANCE_INTERVAL_MS ? "stale" : "running";
    return { state, source: "modeld-owned-housekeeping", serviceEpoch: value.serviceEpoch, ownerIdentity: owner,
      sequence: value.sequence, updatedAtMs: value.updatedAtMs, lastCycle: value.lastCycle, lastSuccessAtMs: value.lastSuccessAtMs, cycleFailure: value.cycleFailure,
      fileBytes: stored.bytes, maxFileBytes: MAX_BYTES, maxStagingBytes: MAX_BYTES,
      intervalMs: STORAGE_MAINTENANCE_INTERVAL_MS, pollingIsLivenessGuarantee: false, installationBudgetEnforced: false, servicesInitialized: false };
  } catch (e) {
    return { state: missing(e) ? "not_observed" : "unavailable", fileBytes: null, maxFileBytes: MAX_BYTES, createsServices: false };
  }
}
