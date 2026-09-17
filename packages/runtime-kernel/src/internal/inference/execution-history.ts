import { Effect } from "effect";
import type { BindingFailure } from "../contract/binding.ts";
import type { LedgerRecord, RouteBindingRecord, TurnRecord } from "./route-binding.ts";

/** Execution authority, NOT the observation journal. No prompt, response, tools,
 * or credential bytes belong here. Cold bindings retain the original resolved
 * configuration and fingerprint, never an AuthLease. */
export type ColdTurn = {
  version: 1;
  turn: TurnRecord;
  binding?: Omit<RouteBindingRecord, "lease">;
};
export type ExecutionHistoryHealth = {
  kind: "leveldb" | "memory-test";
  available: boolean;
  reads: number;
  writes: number;
  failures: number;
  lastError: "storage_unavailable" | null;
  /** Cumulative adapter I/O elapsed time, not a disk-latency estimate. */
  ioTiming?: { readMs: number; writeMs: number };
};
export type ExecutionHistory = {
  getStep(key: string): Effect.Effect<LedgerRecord | undefined, BindingFailure>;
  putStep(key: string, value: LedgerRecord): Effect.Effect<void, BindingFailure>;
  getTurn(key: string): Effect.Effect<ColdTurn | undefined, BindingFailure>;
  putTurn(key: string, value: ColdTurn): Effect.Effect<void, BindingFailure>;
  /** One atomic acknowledged STEP/TURN metadata publication. The Effect Scope
   * is not the transaction; the storage adapter must supply this guarantee. */
  putIdentity(input: { stepKey: string; step: LedgerRecord; turnKey: string; turn: ColdTurn }): Effect.Effect<void, BindingFailure>;
  health(): ExecutionHistoryHealth;
};

/** Capability substitution for kernel tests. The production composition root
 * always supplies the on-disk store; it must never fall back to this on IO error. */
export function memoryExecutionHistory(): ExecutionHistory {
  const steps = new Map<string, LedgerRecord>();
  const turns = new Map<string, ColdTurn>();
  const health: ExecutionHistoryHealth = { kind: "memory-test", available: true, reads: 0, writes: 0, failures: 0, lastError: null };
  const get = <T>(map: Map<string, T>, key: string) => Effect.sync(() => {
    health.reads++;
    const value = map.get(key);
    return value === undefined ? undefined : structuredClone(value);
  });
  const put = <T>(map: Map<string, T>, key: string, value: T) => Effect.sync(() => {
    map.set(key, structuredClone(value)); health.writes++;
  });
  return { getStep: key => get(steps, key), putStep: (key, value) => put(steps, key, value),
    getTurn: key => get(turns, key), putTurn: (key, value) => put(turns, key, value),
    putIdentity: input => Effect.sync(() => {
      const step = structuredClone(input.step), turn = structuredClone(input.turn);
      steps.set(input.stepKey, step); turns.set(input.turnKey, turn); health.writes += 2;
    }), health: () => ({ ...health }) };
}
