import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectJournalSegments, JOURNAL_SEGMENT_POLICY } from "../host/journal-segments.node.ts";
import { observeJournalLockStorage } from "../host/journal-lock.node.ts";

/** Registered diagnostic data only. Never a whole-directory scan or a claim
 * that the current live Host has adopted the writer's rotation policy. */
export async function observeJournalStorage(root: string, requested?: { revision: string; policy: typeof JOURNAL_SEGMENT_POLICY }) {
  const lockMetadata = await observeJournalLockStorage(root);
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
      dataBytes, metadataBytes, lockMetadata, accountedBytes: dataBytes + metadataBytes + lockMetadata.fileBytes,
      accountingComplete: !inventory.pending && !inventory.gaps.length && lockMetadata.accountingComplete,
      segmentCount: inventory.mode === "legacy" ? 1 : inventory.entries.length,
      retiredSegments: inventory.retiredSegments, retiredBytes: inventory.retiredBytes, pendingRecovery: inventory.pending, gaps: inventory.gaps,
      policy: { ...(requested?.policy ?? JOURNAL_SEGMENT_POLICY) }, policySource: requested ? "requested-config" : "built-in-default",
      writerAdoption: inventory.writerPolicy ? "last-write-observed" : "not_observed",
      lastSuccessfulWritePolicy: inventory.writerPolicy ?? null,
      matchesRequestedPolicy: inventory.writerPolicy && requested ? inventory.writerPolicy.storageRevision === requested.revision : null,
      currentWriterLiveness: "not_checked", installationBudgetEnforced: false };
  } catch (e) {
    const absent = e && typeof e === "object" && "code" in e && e.code === "ENOENT";
    return { scope: "registered_structured_journal" as const, state: absent ? "missing" : "unavailable", accountedBytes: null, lockMetadata,
      accountingComplete: false, writerAdoption: "not_checked", installationBudgetEnforced: false };
  }
}
