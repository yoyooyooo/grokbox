import { lstat } from "node:fs/promises";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { OBSERVATION_RETENTION } from "@grokbox/runtime-kernel/observation";
import { sqlitePhysicalUsage } from "./observation-retention.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

/** This limit is for one owned SQLite file, not a claim about the installation's
 * journals/backups/other owners. The enclosing diagnostic pool must account for
 * rollback-journal bytes separately. Apply it to every writer connection. */
export function monitorDatabaseBytes(value = OBSERVATION_RETENTION.monitorDatabaseBytes): number {
  if (!Number.isSafeInteger(value) || value < 512 * 1024 || value > OBSERVATION_RETENTION.maxBytes - OBSERVATION_RETENTION.reserveBytes)
    throw new BoxRuntimeError("invalid_usage", "monitor_invalid_storage_budget");
  return value;
}
export async function capMonitorDatabase(db: MonitorSqlite, maxBytes: number) {
  const pageBytes = Number((await db.first("PRAGMA page_size"))?.page_size ?? 0);
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 512) throw new BoxRuntimeError("invalid_usage", "monitor_store_invalid");
  const requestedPages = Math.floor(monitorDatabaseBytes(maxBytes) / pageBytes);
  const result = await db.first(`PRAGMA max_page_count=${requestedPages}`);
  const effectivePages = Number(result?.max_page_count ?? 0);
  if (!Number.isSafeInteger(effectivePages) || effectivePages < requestedPages) throw new BoxRuntimeError("invalid_usage", "monitor_storage_limit_unavailable");
  // SQLite cannot reduce the cap below the current file. Do not truncate a
  // pre-existing oversized database; report it and reclaim through its owner.
  return { requestedBytes: requestedPages * pageBytes, effectiveBytes: effectivePages * pageBytes, existingOversize: effectivePages > requestedPages };
}
export async function monitorAuxiliaryUsage(file: string) {
  let bytes = 0, allocatedBytes = 0;
  const files: Array<{ kind: string; bytes: number; allocatedBytes: number }> = [];
  const unavailable: string[] = [];
  for (const [kind, suffix] of [["rollback-journal", "-journal"], ["wal", "-wal"], ["shared-memory", "-shm"]] as const) {
    try {
      const info = await lstat(file + suffix);
      if (!info.isFile() || info.isSymbolicLink()) { unavailable.push(kind); continue; }
      const blocks = Number.isSafeInteger(info.blocks) ? info.blocks * 512 : info.size;
      bytes += info.size; allocatedBytes += blocks; files.push({ kind, bytes: info.size, allocatedBytes: blocks });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) unavailable.push(kind);
    }
  }
  return { bytes, allocatedBytes, files, unavailable, sampling: "non_atomic_filesystem_snapshot" as const };
}
export async function monitorWriteAdmission(db: MonitorSqlite, maxBytes: number, incomingEstimate: number) {
  if (!Number.isSafeInteger(incomingEstimate) || incomingEstimate < 0) throw new BoxRuntimeError("invalid_usage", "monitor_invalid_storage_budget");
  const physical = await sqlitePhysicalUsage(db);
  const reserveBytes = Math.min(OBSERVATION_RETENTION.monitorReserveBytes, Math.floor(maxBytes / 8));
  const accepted = physical.allocatedBytes <= maxBytes && physical.livePageBytes + incomingEstimate <= maxBytes - reserveBytes;
  return { accepted, maxBytes, reserveBytes, physical,
    reason: accepted ? null : physical.allocatedBytes > maxBytes ? "existing_database_oversize" : "storage_pressure" };
}
