import { createManagementGatewayIO } from "../io/management-gateway.node.ts";
import { createContinuityGatewayIO, type ContinuityCall, type ContinuityPrograms } from "../io/continuity-gateway.node.ts";
import { runAgentRoutineCommand } from "./agent-routines.runtime.ts";
import { runRoutineProvisionCommand } from "./routine-provision.runtime.ts";

/** Existing application owners are injected into transport adapters here. IO
 * never imports or selects a second lifecycle/provision program by itself. */
const programs: ContinuityPrograms = {
  routineProvision: runRoutineProvisionCommand,
  agentRoutines: runAgentRoutineCommand,
};
export function createManagementGateway(options: Parameters<typeof createManagementGatewayIO>[0]) {
  return createManagementGatewayIO(options, programs);
}
export function createContinuityGateway(call: ContinuityCall, root: string, signal: AbortSignal) {
  return createContinuityGatewayIO(call, root, signal, programs);
}
