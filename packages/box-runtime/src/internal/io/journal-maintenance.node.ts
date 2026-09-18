import { inspectJournalSegments, maintainSegmentedJournal } from "../host/journal-segments.node.ts";
import { withEventsLock } from "../host/terminal-journal.node.ts";

export type JournalMaintenanceReceipt = {
  source: "control" | "host";
  state: "maintained" | "not_segmented" | "busy" | "unavailable";
  reclaimedBytes: number; elapsedMs: number;
};
/** An existing service's bounded housekeeping slice, not another daemon/GC
 * controller. Only two explicit roots, no directory scan or legacy rewrite.
 * A held writer lock is skipped immediately; no guessing dead owners or unlink.
 * The caller must await settlement before releasing its service Scope. */
export async function maintainRegisteredJournals(input: { durableRoot: string; runRoot?: string; signal?: AbortSignal; nowMs?: number }) {
  const roots: Array<{ source: "control" | "host"; root: string }> = [{ source: "control", root: input.durableRoot }];
  if (input.runRoot && input.runRoot !== input.durableRoot) roots.push({ source: "host", root: input.runRoot });
  const receipts: JournalMaintenanceReceipt[] = [];
  for (const { source, root } of roots) {
    if (input.signal?.aborted) break;
    const started = performance.now();
    let state: JournalMaintenanceReceipt["state"] = "unavailable", reclaimedBytes = 0;
    try {
      const before = await inspectJournalSegments(root);
      if (before.mode === "legacy") state = "not_segmented";
      else {
        await withEventsLock(root, async () => {
          if (input.signal?.aborted) return;
          const lockedBefore = await inspectJournalSegments(root);
          await maintainSegmentedJournal(root, { configurationRoot: input.durableRoot, nowMs: input.nowMs });
          const after = await inspectJournalSegments(root);
          reclaimedBytes = Math.max(0, after.retiredBytes - lockedBefore.retiredBytes);
          state = "maintained";
        }, 1);
      }
    } catch (error) {
      state = error && typeof error === "object" && "code" in error && error.code === "LOCK_TIMEOUT" ? "busy" : "unavailable";
    }
    receipts.push({ source, state, reclaimedBytes, elapsedMs: Math.max(0, performance.now() - started) });
  }
  return { roots: receipts, cancelled: input.signal?.aborted === true, installedScheduler: false as const };
}
