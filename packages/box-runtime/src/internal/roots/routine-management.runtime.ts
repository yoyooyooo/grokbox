import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { RoutineError, RoutineProvisionError, type RoutineOperationReceipt } from "@grokbox/runtime-kernel/routines";
import { openRoutineProvisionStore, type RoutineStateRecord } from "../io/routine-provision.node.ts";
import type { RoutineAccess } from "../io/routine-gateway.node.ts";
import { runAgentRoutineCommand } from "./agent-routines.runtime.ts";

/** Add a durable dispatch guard to the existing native Routine use case, using
 * the same Routine-domain database as provision. Unknown work is never retried
 * through a different request ID; reads/replays never depend on current native
 * availability. The old preflight/readback-only evidence limit is retained. */
export async function changeManagedRoutine(input: {
  root: string; operationId: string; agentId: string; nativeId: string; action: "enable" | "disable" | "delete";
  expectedRevision: string; fingerprint: string; native: RoutineAccess; signal: AbortSignal;
}): Promise<RoutineStateRecord> {
  const store = openRoutineProvisionStore(input.root);
  const previous = await store.stateRecord(input.agentId, input.operationId);
  if (previous) {
    if (previous.fingerprint !== input.fingerprint) throw new RoutineProvisionError("operation_conflict");
    return previous;
  }
  if (await store.read(input.agentId, input.operationId)) throw new RoutineProvisionError("operation_conflict");
  input.signal.throwIfAborted();
  const before = await input.native.list(input.agentId), item = before.catalog.routines.find(r => r.id === input.nativeId);
  if (!item) throw new RoutineError("not_found_in_window");
  if (!item.mutable) throw new RoutineError("unsupported_trigger");
  if (item.revision !== input.expectedRevision) throw new RoutineError("revision_conflict");
  input.signal.throwIfAborted();
  const reserved = await store.reserveState({ operationId: input.operationId, agentId: input.agentId, nativeId: input.nativeId,
    action: input.action, fingerprint: input.fingerprint, beforeRevision: item.revision, definitionRevision: item.definitionRevision,
    generation: before.generation, createdAtMs: Date.now() });
  if (!reserved.dispatch) return reserved.record;
  let firstRead = true;
  try {
    // Same rules as the native primitive; the first immutable snapshot was
    // acquired before reserve, subsequent reads hit the pinned source again.
    const result = await runAgentRoutineCommand({ command: { action: input.action, agentId: input.agentId, routineId: input.nativeId,
      expectedRevision: input.expectedRevision, confirmed: true, operationId: input.operationId }, signal: input.signal,
      native: { list: async id => { if (firstRead) { firstRead = false; return before; } return input.native.list(id); }, change: input.native.change } }) as RoutineOperationReceipt;
    return await store.settleState(reserved.record, result.afterRevision,
      result.state === "absent_in_returned_window" ? "absent-in-returned-window" : "requested-state-observed");
  } catch {
    await store.markStateUnknown(reserved.record).catch(() => undefined);
    return { ...reserved.record, state: "unknown" };
  }
}

export const routineStateFingerprint = (input: { agentId: string; nativeId: string; action: string; expectedRevision: string }) => sha256Text(canonicalJson(input));
