import { join } from "node:path";
import { Effect } from "effect";
import { ContinuityFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import { readContinuityIdentity } from "../io/continuity-database.node.ts";
import { assertSafeDirectory } from "../io/config-layout.node.ts";
import { acquireAdvisoryGate } from "../io/advisory-gate.node.ts";

/** Queries never initialize the safety database. The immutable workflow already
 * owns request identity, private inputs, dispatch claims and recovery history. */
export async function readManagedLifecycle(root: string, scopeId: string, operationId: string) {
  const identity = await readContinuityIdentity(root);
  if (!identity) return null;
  if (identity.scopeId !== scopeId) throw new ContinuityFailure("scope_mismatch");
  const db = continuityWorkflowPrograms({ durableRoot: root, scopeId });
  try {
    const request = await Effect.runPromise(db.request(operationId));
    const receipt = await Effect.runPromise(db.status(operationId));
    return { request, receipt };
  } catch (error) { if (error instanceof ContinuityFailure && error.code === "not_found") return null; throw error; }
}
export async function listManagedLifecycles(root: string, installationId: string, principalId: string, limit: number, cursor?: { scopeId: string; after: string }) {
  const identity = await readContinuityIdentity(root);
  if (!identity) {
    if (cursor) throw new ContinuityFailure("scope_mismatch");
    return { scopeId: null, requests: [] as BotWorkflowRequest[], nextCursor: null };
  }
  if (cursor && cursor.scopeId !== identity.scopeId) throw new ContinuityFailure("scope_mismatch");
  const result = await Effect.runPromise(continuityWorkflowPrograms({ durableRoot: root, scopeId: identity.scopeId }).managedRequests(installationId, principalId, limit, cursor?.after));
  return { scopeId: identity.scopeId, ...result };
}

/** Serialize admitted manual lifecycle drivers across requests and processes.
 * One permanent inode bounds lock metadata; no long-lived helper process, no
 * per-request file growth. CONT step claims still own external idempotency.
 * The caller's bounded transport signal cancels native work; this owner joins
 * that work and its final durable checkpoint before releasing the gate. */
export async function withManagedLifecycleGate<A>(root: string, run: () => Promise<A>, signal: AbortSignal): Promise<A | null> {
  signal.throwIfAborted();
  await assertSafeDirectory(root); await assertSafeDirectory(join(root, "state"), true);
  const program = Effect.acquireUseRelease(
    Effect.uninterruptible(Effect.tryPromise({ try: () => acquireAdvisoryGate(join(root, "state", "manual-lifecycle.gate")), catch: error => error })),
    gate => gate ? Effect.uninterruptible(Effect.tryPromise({ try: run, catch: error => error })) : Effect.succeed(null),
    gate => gate ? Effect.promise(gate.release) : Effect.void,
  );
  return Effect.runPromise(program, { signal });
}
