import { Cause, Effect, Exit } from "effect";
import { AgentRoutines } from "@grokbox/runtime-kernel/ports";
import { runAgentRoutines } from "@grokbox/runtime-kernel/commands";
import { RoutineError, type RoutineCommand, type RoutineSnapshot } from "@grokbox/runtime-kernel/routines";

export type AgentRoutineAdapter = {
  list: (agentId: string) => Promise<RoutineSnapshot>;
  change: (agentId: string, routineId: string, action: "enable" | "disable" | "delete") => Promise<RoutineSnapshot>;
};
/** CLI/native adapters supply only their bounded port. No CLI imports, native
 * database writes, service installation or persistent policy in this root. */
export async function runAgentRoutineCommand(input: { command: RoutineCommand; native: AgentRoutineAdapter; signal?: AbortSignal }) {
  const io = <A>(run: () => Promise<A>, write = false) => Effect.tryPromise({ try: run,
    catch: e => e instanceof RoutineError ? e : new RoutineError(write ? "outcome_unknown" : "read_unavailable") });
  const result = await Effect.runPromiseExit(runAgentRoutines(input.command).pipe(Effect.provideService(AgentRoutines, {
    list: id => io(() => input.native.list(id)),
    change: (id, rid, action) => io(() => input.native.change(id, rid, action), true),
  })), { signal: input.signal });
  if (Exit.isSuccess(result)) return result.value;
  const failure = Cause.squash(result.cause);
  if (failure instanceof RoutineError) throw failure;
  throw new RoutineError(input.command.action === "list" || input.command.action === "show" ? "read_unavailable" : "outcome_unknown");
}
