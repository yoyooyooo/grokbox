import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";

/** Public synthetic facts, not a CLI/local harness default or a copied Server row. */
export function ownedOwnershipSnapshot(agentIds: string[], options: {
  nowMs?: number; scopeId?: string; serverHarness?: "box" | "temporal" | "unknown";
  localHarness?: "box" | "temporal" | "unknown"; migrating?: boolean;
  localWorkAllowed?: boolean; executorBound?: boolean;
} = {}) {
  const at = new Date(options.nowMs ?? Date.now()).toISOString();
  const window = options.migrating ? { kind: "active", status: "busy" } : { kind: "inactive" };
  const execution = { allowed: options.localWorkAllowed ?? true, bound: options.executorBound ?? true };
  return { schemaVersion: 3, source: "Host.official-client/ListGrokBotAgents", state: "observed",
    observedAt: at, completedAt: at, serverObservedAt: at, errorCode: null,
    scope: { id: options.scopeId ?? "a".repeat(64), stable: true },
    localMigrationWindow: { before: window, after: window },
    localExecution: { before: execution, after: execution },
    agents: agentIds.map(agentId => ({ agentId, serverEvidence: "found",
      server: { agentId, serverId: `owned-${agentId}`, harness: options.serverHarness ?? "box", viewerIsOwner: true },
      local: { before: { serverId: `owned-${agentId}`, harness: options.localHarness ?? "box" },
        after: { serverId: `owned-${agentId}`, harness: options.localHarness ?? "box" }, stable: true } })),
  };
}
export function ownedOwnershipReader(pid: number, options: Parameters<typeof ownedOwnershipSnapshot>[1] = {}): OwnershipReader {
  return async (agentIds, signal) => {
    if (signal.aborted) throw new Error("owned-read-cancelled");
    return { snapshot: ownedOwnershipSnapshot(agentIds, options), gateway: { pid, startedAt: 1 } };
  };
}
