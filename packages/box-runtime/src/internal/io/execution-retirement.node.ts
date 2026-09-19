import { lstat, opendir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { ClassicLevel } from "classic-level";
import { BindingFailure } from "@grokbox/runtime-kernel/contract";
import type { ColdTurn, ExecutionRetirementReceipt } from "@grokbox/runtime-kernel/inference";

/** The execution owner's budget, not an observation TTL or STEP count. Existing
 * records are never dropped to admit an effect. Compaction overlap is reserved. */
export const EXECUTION_STORAGE_POLICY = Object.freeze({
  targetBytes: 64 * 1024 * 1024, maxBytes: 160 * 1024 * 1024,
  transitionReserveBytes: 32 * 1024 * 1024, maxFiles: 2048, batch: 128,
});
export async function executionFootprint(path: string) {
  const dir = await lstat(path);
  if (!dir.isDirectory() || dir.isSymbolicLink() || process.getuid && dir.uid !== process.getuid()) throw new BindingFailure("ledger_unavailable");
  const handle = await opendir(path); let bytes = dir.blocks * 512, files = 0;
  try {
    for (;;) {
      const entry = await handle.read(); if (!entry) break;
      if (++files > EXECUTION_STORAGE_POLICY.maxFiles) throw new BindingFailure("ledger_unavailable");
      const value = await lstat(join(path, entry.name)).catch(e => {
        if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
        throw e;
      });
      // LevelDB may retire a file during this metadata observation. Admission
      // reserves transition headroom; this is not a zero-race disk snapshot.
      if (!value) continue;
      if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || process.getuid && value.uid !== process.getuid()) throw new BindingFailure("ledger_unavailable");
      bytes += Math.max(value.size, value.blocks * 512);
      if (!Number.isSafeInteger(bytes)) throw new BindingFailure("ledger_unavailable");
    }
  } finally { await handle.close(); }
  return { fileBytes: bytes, files };
}

/** Under the adapter's write queue, only retire STEP rows indexed to an already
 * closed/revoked TURN. reserveStep/occupy consume that retained TURN certificate
 * before provider effects. Neither age nor diagnostic success closes a TURN. */
export async function retireExecutionBatch(db: ClassicLevel<string, unknown>, path: string): Promise<ExecutionRetirementReceipt> {
  let retiredSteps = 0, closedTurns = 0, blockedActiveSteps = 0;
  const batchLimit = EXECUTION_STORAGE_POLICY.batch;
  for await (const [queueKey] of db.iterator({ gte: "r!", lt: "r\"", limit: 8 })) {
    const turnHash = queueKey.slice(2);
    if (!/^[a-f0-9]{64}$/.test(turnHash)) throw new BindingFailure("ledger_unavailable");
    const turn = await db.get(`t!${turnHash}`) as ColdTurn | undefined;
    if (!turn || turn.version !== 1 || !turn.turn || !["closed", "revoked"].includes(turn.turn.lifecycle)
      || typeof turn.turn.serviceEpoch !== "string" || turn.turn.serviceEpoch !== await db.get("!service-epoch")
      || typeof turn.turn.expired !== "boolean" || !Number.isFinite(turn.turn.lastActivityMs)) throw new BindingFailure("ledger_unavailable");
    const changes: Array<{ type: "del"; key: string }> = [];
    const prefix = `x!${turnHash}!`;
    for await (const [membership] of db.iterator({ gte: prefix, lt: `${prefix}~`, limit: batchLimit - retiredSteps })) {
      const stepHash = membership.slice(prefix.length);
      if (!/^[a-f0-9]{64}$/.test(stepHash)) throw new BindingFailure("ledger_unavailable");
      const step = await db.get(`s!${stepHash}`) as { status?: string } | undefined;
      if (step && !["active", "terminal", "rejected", "cancelled"].includes(step.status ?? "")) throw new BindingFailure("ledger_unavailable");
      if (step?.status === "active") { blockedActiveSteps++; continue; }
      changes.push({ type: "del", key: `s!${stepHash}` }, { type: "del", key: membership }); retiredSteps++;
    }
    if (changes.length) await db.batch(changes, { sync: true });
    let remaining = false;
    for await (const _ of db.keys({ gte: prefix, lt: `${prefix}~`, limit: 1 })) { remaining = true; }
    if (!remaining) {
      // Resolved configuration is no longer required by a closed TURN. Keep its
      // exact denied identity until service-epoch retirement. Unknown stays put.
      await db.batch([
        { type: "put", key: `t!${turnHash}`, value: { version: 1, turn: turn.turn } },
        { type: "del", key: queueKey },
      ], { sync: true }); closedTurns++;
    }
    if (retiredSteps >= batchLimit) break;
  }
  const usage = await executionFootprint(path);
  return { state: blockedActiveSteps ? "protected" : "maintained", retiredSteps, closedTurns,
    blockedActiveSteps, fileBytes: usage.fileBytes, maxBytes: EXECUTION_STORAGE_POLICY.maxBytes,
    authority: "closed-turn-and-service-epoch", ttlDeletion: false, replayAuthorized: false };
}

export async function admitExecutionWrite(path: string, recordBytes: number) {
  if (!Number.isSafeInteger(recordBytes) || recordBytes < 0 || recordBytes > 256 * 1024) throw new BindingFailure("ledger_unavailable");
  const usage = await executionFootprint(path), policy = EXECUTION_STORAGE_POLICY;
  // Two complete existing file sets plus fixed memtable/log overhead cover a
  // compaction overlap conservatively. This is writer admission, not OS quota.
  const required = 2 * usage.fileBytes + policy.transitionReserveBytes + 4 * recordBytes;
  const fs = await statfs(path);
  if (required > policy.maxBytes || fs.bavail * fs.bsize < usage.fileBytes + policy.transitionReserveBytes + 4 * recordBytes) throw new BindingFailure("ledger_storage_pressure");
  return usage;
}
