import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectJournalSegments, JOURNAL_SEGMENT_POLICY } from "../host/journal-segments.node.ts";

/** Registered diagnostic data only. Never a whole-directory scan or a claim
 * that the current live Host has adopted the writer's rotation policy. */
export async function observeJournalStorage(root: string) {
  try {
    const inventory = await inspectJournalSegments(root);
    let dataBytes = inventory.entries.reduce((n, s) => n + s.bytes, 0), metadataBytes = 0;
    if (inventory.mode === "legacy") {
      const active = await lstat(join(root, "log", "events.ndjson"));
      if (!active.isFile() || active.isSymbolicLink() || active.nlink !== 1) throw Error("journal_storage_unsafe");
      dataBytes = active.size;
    } else for (const name of ["events.segments.json", "events.segments.next.json"]) {
      try {
        const meta = await lstat(join(root, "log", name));
        if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1) throw Error("journal_storage_unsafe");
        metadataBytes += meta.size;
      } catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e; }
    }
    return { scope: "registered_structured_journal" as const, state: inventory.gaps.length ? "partial" : "available", format: inventory.mode,
      dataBytes, metadataBytes, accountedBytes: dataBytes + metadataBytes, accountingComplete: !inventory.pending && !inventory.gaps.length,
      segmentCount: inventory.mode === "legacy" ? 1 : inventory.entries.length,
      retiredSegments: inventory.retiredSegments, retiredBytes: inventory.retiredBytes, pendingRecovery: inventory.pending, gaps: inventory.gaps,
      policy: { ...JOURNAL_SEGMENT_POLICY }, writerAdoption: "not_checked", installationBudgetEnforced: false };
  } catch (e) {
    const absent = e && typeof e === "object" && "code" in e && e.code === "ENOENT";
    return { scope: "registered_structured_journal" as const, state: absent ? "missing" : "unavailable", accountedBytes: null,
      accountingComplete: false, writerAdoption: "not_checked", installationBudgetEnforced: false };
  }
}
