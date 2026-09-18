import { effectiveStorage, configurationRevisions, storageAllocation } from "@grokbox/runtime-kernel/config";
import { DAY_MS } from "@grokbox/runtime-kernel/observation";
import { openConfigStore } from "./config-store.node.ts";
import { rootConfigLayout } from "./config-layout.node.ts";

/** Read the canonical configuration, never a second policy file or a caller's
 * HOME fallback. Invalid/in-progress configuration is not replaced by defaults.
 * Captured intent does not prove adoption by other storage owners. */
export async function readStorageConfiguration(durableRoot: string) {
  const snapshot = await openConfigStore(rootConfigLayout(durableRoot)).read();
  const policy = effectiveStorage(snapshot.document.storage);
  return { policy, revision: configurationRevisions(snapshot.document).storage,
    source: snapshot.exists ? "canonical-config" as const : "default-no-config" as const,
    allocation: storageAllocation(policy),
    monitor: { maxDatabaseBytes: policy.retention.monitor.maxBytes,
      retentionMs: policy.diagnostics.detailDays * DAY_MS, summaryMs: policy.diagnostics.summaryDays * DAY_MS } };
}
export type StorageConfiguration = Awaited<ReturnType<typeof readStorageConfiguration>>;
