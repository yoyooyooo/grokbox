import { Cause, Effect, Exit } from "effect";
import { RoutineProvisionLedger, NativeRoutineProvision } from "@grokbox/runtime-kernel/ports";
import { runRoutineProvision } from "@grokbox/runtime-kernel/commands";
import { RoutineProvisionError, validateProvisionCommand, type RoutineBlueprint, type ProvisionObservation } from "@grokbox/runtime-kernel/routines";
import { openRoutineProvisionStore, type ProvisionStoreHooks } from "../io/routine-provision.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";

export type RoutineProvisionNative = {
  list: (agentId: string) => Promise<ProvisionObservation>;
  write: (agentId: string, blueprint: RoutineBlueprint, nativeId: string | null) => Promise<ProvisionObservation>;
};
export async function runRoutineProvisionCommand(input: { durableRoot: string; command: unknown; native: RoutineProvisionNative; signal?: AbortSignal;
  nowMs?: number; hooks?: ProvisionStoreHooks }) {
  const command = validateProvisionCommand(input.command);
  if (command.action !== "outcome") {
    try { await openConfigStore(rootConfigLayout(input.durableRoot)).read(); }
    catch { throw new RoutineProvisionError("ledger_unavailable"); }
  }
  const store = openRoutineProvisionStore(input.durableRoot, input.hooks);
  const io = <A>(run: () => Promise<A>, source = false) => Effect.tryPromise({ try: run,
    catch: e => e instanceof RoutineProvisionError ? e : new RoutineProvisionError(source ? "source_unavailable" : "ledger_unavailable") });
  const result = await Effect.runPromiseExit(runRoutineProvision(input.command, input.nowMs ?? Date.now()).pipe(
    Effect.provideService(RoutineProvisionLedger, {
      read: (agent, op) => io(() => store.read(agent, op)), binding: (agent, key) => io(() => store.binding(agent, key)),
      reserve: value => io(() => store.reserve(value)), markUnknown: (agent, op) => io(() => store.markUnknown(agent, op)),
      reconcileRecord: (agent, op) => io(() => store.reconcileRecord(agent, op)), finish: (record, id, revision) => io(() => store.finish(record, id, revision)),
    }),
    Effect.provideService(NativeRoutineProvision, { list: id => io(() => input.native.list(id), true), write: (id, spec, rid) => io(() => input.native.write(id, spec, rid), true) }),
  ), { signal: input.signal });
  if (Exit.isSuccess(result)) return result.value;
  const failure = Cause.squash(result.cause);
  throw failure instanceof RoutineProvisionError ? failure : new RoutineProvisionError("outcome_unknown");
}
