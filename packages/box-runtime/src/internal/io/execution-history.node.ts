import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { BindingFailure, projectProviderRecoveryState } from "@grokbox/runtime-kernel/contract";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import type { ColdTurn, ExecutionHistory, ExecutionHistoryHealth, LedgerRecord } from "@grokbox/runtime-kernel/inference";
import type { ClassicLevel } from "classic-level";

const fail = () => new BindingFailure("ledger_unavailable");
const digest = (value: unknown) => typeof value === "string" && (value === "" || /^[a-f0-9]{64}$/.test(value));
function stepRecord(value: unknown): LedgerRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as Record<string, unknown>;
  if (!digest(v.snapshotDigest) || !digest(v.selectionRevision)
    || !["active", "terminal", "rejected", "cancelled"].includes(String(v.status))
    || (v.bindingId !== undefined && !digest(v.bindingId))
    || Object.keys(v).some(k => !["snapshotDigest", "selectionRevision", "bindingId", "status", "recovery"].includes(k))) throw fail();
  if (v.recovery !== undefined) {
    const checked = projectProviderRecoveryState(v.recovery);
    if (!checked || canonicalJson(checked) !== canonicalJson(v.recovery)) throw fail();
  }
  return v as LedgerRecord;
}
function turnRecord(value: unknown): ColdTurn | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as ColdTurn;
  if (v.version !== 1 || !v.turn || typeof v.turn.serviceEpoch !== "string"
    || !["open", "revoked", "closed"].includes(v.turn.lifecycle) || typeof v.turn.expired !== "boolean"
    || !Number.isFinite(v.turn.lastActivityMs)) throw fail();
  if (v.binding && (!digest(v.binding.bindingId) || !v.binding.model || !v.binding.selection
    || !v.binding.ownership || typeof v.binding.fingerprint !== "string" || "lease" in v.binding)) throw fail();
  return v;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  await chmod(path, 0o700);
}

/** The LevelDB lock is the one writer owner for this root. A new incarnation
 * first retires the old index while exclusively locked, then publishes its epoch
 * before the Unix listener starts. Old epoch requests cannot pass the kernel.
 * No live record-count ceiling, no full-database JS heap load, no JSON/image
 * rewrite per STEP. LevelDB handles block caching and incremental compaction. */
export function openExecutionHistory(runRoot: string, serviceEpoch: string) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await privateDirectory(runRoot);
        await privateDirectory(join(runRoot, "state"));
        const path = join(runRoot, "state", "modeld-execution");
        await privateDirectory(path);
        const { ClassicLevel } = await import("classic-level");
        const db = new ClassicLevel<string, unknown>(path, { valueEncoding: "json" });
        try {
          await db.open(); // LEVEL_LOCKED refuses a competing writer; never delete its lock.
          const previous = await db.get("!service-epoch");
          if (previous === serviceEpoch) throw fail(); // Restart must get a new incarnation.
          if (previous !== undefined) {
            await db.clear();
            await db.compactRange("\u0000", "\uffff");
          }
          await db.put("!service-epoch", serviceEpoch, { sync: true });
          return db;
        } catch (error) { await db.close().catch(() => undefined); throw error; }
      },
      catch: fail,
    }),
    db => Effect.promise(() => db.close()),
  ).pipe(Effect.map(db => historyAdapter(db)));
}

function historyAdapter(db: ClassicLevel<string, unknown>): ExecutionHistory {
  const state: ExecutionHistoryHealth = { kind: "leveldb", available: true, reads: 0, writes: 0, failures: 0, lastError: null };
  // A successful read does not prove that a previously failed write can now
  // commit a new identity claim (for example after ENOSPC). Recover each side
  // only on an actually successful operation on that side.
  const failed = { read: false, write: false };
  const ioTiming = { readMs: 0, writeMs: 0 };
  const io = <T>(side: "read" | "write", operation: () => Promise<T>) => Effect.tryPromise({
    try: async () => {
      const started = performance.now();
      try {
        const result = await operation();
        failed[side] = false;
        state.available = !failed.read && !failed.write;
        state.lastError = state.available ? null : "storage_unavailable";
        return result;
      } finally {
        ioTiming[side === "read" ? "readMs" : "writeMs"] += Math.max(0, performance.now() - started);
      }
    },
    catch: () => { failed[side] = true; state.available = false; state.failures++; state.lastError = "storage_unavailable"; return fail(); },
  });
  return {
    getStep: key => io("read", async () => { state.reads++; return stepRecord(await db.get(`s!${sha256Text(key)}`)); }),
    putStep: (key, value) => io("write", async () => {
      const checked = stepRecord(value);
      if (!checked) throw fail();
      await db.put(`s!${sha256Text(key)}`, checked, { sync: true }); state.writes++;
    }),
    getTurn: key => io("read", async () => { state.reads++; return turnRecord(await db.get(`t!${sha256Text(key)}`)); }),
    putTurn: (key, value) => io("write", async () => {
      const checked = turnRecord(value);
      if (!checked) throw fail();
      await db.put(`t!${sha256Text(key)}`, checked, { sync: true }); state.writes++;
    }),
    putIdentity: input => io("write", async () => {
      const step = stepRecord(input.step), turn = turnRecord(input.turn);
      if (!step || !turn) throw fail();
      await db.batch<string, unknown>([
        { type: "put", key: `s!${sha256Text(input.stepKey)}`, value: step },
        { type: "put", key: `t!${sha256Text(input.turnKey)}`, value: turn },
      ], { sync: true });
      state.writes += 2;
    }),
    health: () => ({ ...state, ioTiming: { ...ioTiming } }),
  };
}
