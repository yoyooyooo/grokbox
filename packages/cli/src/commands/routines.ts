import { RoutineError, validateRoutineCommand, type RoutineAction, type RoutineCommand } from "@grokbox/runtime-kernel/routines";
import type { CliDeps } from "../deps.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { routineCliError } from "../gateway-automation.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";

export async function runRoutines(deps: CliDeps, action: RoutineAction, agentId: string, routineId: string | undefined,
  raw: { json?: boolean; timeoutMs?: string; expectRevision?: string; confirm?: boolean; operationId?: string }) {
  const io = ioFromOpts(raw), write = action !== "list" && action !== "show";
  let command: RoutineCommand;
  try { command = validateRoutineCommand({ action, agentId, ...(routineId ? { routineId } : {}),
    ...(write ? { expectedRevision: raw.expectRevision, confirmed: raw.confirm === true, operationId: raw.operationId ?? deps.randomUUID() } : {}) }); }
  catch (e) { throw routineCliError(e instanceof RoutineError ? e : new RoutineError("invalid_input")); }
  const client = new GatewayClient(deps);
  const observed = await client.agentRoutines(command, io.timeoutMs);
  writeSuccess(deps.stdout, observed.result, gatewayMeta(observed.discovery));
}
