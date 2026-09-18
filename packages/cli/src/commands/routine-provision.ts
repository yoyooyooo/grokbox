import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { ROUTINE_PROVISION_POLICY, RoutineProvisionError, parseRoutineBlueprint, validateProvisionCommand, type RoutineProvisionCommand } from "@grokbox/runtime-kernel/routines";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { provisionCliError } from "../gateway-routine-provision.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";
import type { CliDeps } from "../deps.ts";

async function blueprintFile(path: string | undefined) {
  if (!path || path === "-") throw new RoutineProvisionError("invalid_input");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > ROUTINE_PROVISION_POLICY.maxInputBytes) throw new RoutineProvisionError("invalid_input");
    const bytes = Buffer.alloc(ROUTINE_PROVISION_POLICY.maxInputBytes + 1); let total = 0;
    while (total < bytes.length) { const read = await handle.read(bytes, total, bytes.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
    const after = await handle.stat(), named = await lstat(path);
    if (total !== before.size || total > ROUTINE_PROVISION_POLICY.maxInputBytes || before.ino !== named.ino || before.dev !== named.dev
      || named.isSymbolicLink() || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new RoutineProvisionError("invalid_input");
    return parseRoutineBlueprint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))));
  } finally { await handle.close(); }
}
export async function runRoutineProvisionCli(deps: CliDeps, action: RoutineProvisionCommand["action"], agentId: string,
  raw: { json?: boolean; timeoutMs?: string; operationId?: string; confirm?: boolean; from?: string; expectRevision?: string; routineId?: string }) {
  const io = ioFromOpts(raw); let command: RoutineProvisionCommand;
  try {
    if (action !== "outcome" && raw.confirm !== true) throw new RoutineProvisionError("confirmation_required");
    command = validateProvisionCommand({ action, agentId, operationId: raw.operationId,
      ...(action !== "outcome" ? { confirmed: true } : {}),
      ...(action === "apply" ? { blueprint: await blueprintFile(raw.from), ...(raw.expectRevision ? { expectedRevision: raw.expectRevision } : {}) } : {}),
      ...(action === "reconcile" ? { routineId: raw.routineId } : {}) });
  } catch (e) { throw provisionCliError(e instanceof RoutineProvisionError ? e : new RoutineProvisionError("invalid_input")); }
  const observed = await new GatewayClient(deps).routineProvision(command, io.timeoutMs);
  if (command.action !== "outcome" && observed.result.state === "outcome_unknown") throw provisionCliError(new RoutineProvisionError("outcome_unknown"), command);
  writeSuccess(deps.stdout, observed.result, observed.discovery ? gatewayMeta(observed.discovery) : undefined);
}
