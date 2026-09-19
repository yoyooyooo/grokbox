import { observationOwn as own } from "../contract/provider-observation.ts";
import { evidenceIdentity } from "./evidence-contract.ts";

export type NativeRunHealth = {
  schemaVersion: 1; source: "native_run_observer"; hostGenerationId: string;
  observedAtMs: number; startedAtMs: number; targetIds: string[];
  coverage: "observed_window" | "partial"; droppedTasks: number; taskLimit: 256;
  tasks: Array<{ agentId: string; dispatchId: string; state: "queued" | "started";
    phase: "native" | "model" | "tool_or_approval"; lastProgressMs: number }>;
};
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** An actual, source-owned bounded snapshot. Reading a journal or checking a PID
 * is not this evidence. Explicit target/window coverage never asserts that all
 * native child tasks or external effects have terminated. */
export function projectNativeRunHealth(value: unknown): NativeRunHealth | undefined {
  const generation = own(value, "hostGenerationId"), observedAtMs = own(value, "observedAtMs"), startedAtMs = own(value, "startedAtMs"),
    targetIds = own(value, "targetIds"), tasks = own(value, "tasks"), droppedTasks = own(value, "droppedTasks"), coverage = own(value, "coverage");
  if (own(value, "schemaVersion") !== 1 || own(value, "source") !== "native_run_observer" || !evidenceIdentity(generation)
    || !time(observedAtMs) || !time(startedAtMs) || startedAtMs > observedAtMs || !Array.isArray(targetIds) || !targetIds.length || targetIds.length > 32
    || !targetIds.every(evidenceIdentity) || new Set(targetIds).size !== targetIds.length || !Array.isArray(tasks) || tasks.length > 256
    || !count(droppedTasks) || !["observed_window", "partial"].includes(coverage as string) || own(value, "taskLimit") !== 256) return undefined;
  const projected: NativeRunHealth["tasks"] = [], ids = new Set<string>();
  for (const task of tasks) {
    const agentId = own(task, "agentId"), dispatchId = own(task, "dispatchId"), state = own(task, "state"),
      phase = own(task, "phase"), lastProgressMs = own(task, "lastProgressMs");
    if (!evidenceIdentity(agentId) || !targetIds.includes(agentId) || !evidenceIdentity(dispatchId) || ids.has(dispatchId)
      || !["queued", "started"].includes(state as string) || !["native", "model", "tool_or_approval"].includes(phase as string)
      || !time(lastProgressMs) || lastProgressMs > observedAtMs || lastProgressMs < startedAtMs) return undefined;
    ids.add(dispatchId);
    projected.push({ agentId, dispatchId, state: state as "queued" | "started", phase: phase as "native" | "model" | "tool_or_approval", lastProgressMs });
  }
  return { schemaVersion: 1, source: "native_run_observer", hostGenerationId: generation, observedAtMs, startedAtMs,
    targetIds: [...targetIds], coverage: coverage as NativeRunHealth["coverage"], droppedTasks, taskLimit: 256, tasks: projected };
}
export function projectNativeRunHealthEvent(value: unknown): (NativeRunHealth & { name: "host_run_health"; at: string }) | null {
  const native = projectNativeRunHealth(value), at = own(value, "at");
  if (!native || own(value, "name") !== "host_run_health" || typeof at !== "string" || at !== new Date(native.observedAtMs).toISOString()) return null;
  return { ...native, name: "host_run_health", at };
}
export const NATIVE_RUN_HEALTH_MAX_AGE_MS = 5000;
