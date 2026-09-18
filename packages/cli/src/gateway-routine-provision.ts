import { runRoutineProvisionCommand } from "@grokbox/box-runtime/runtime";
import { RoutineProvisionError, NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines, nativeRoutineSpec, observedRoutineDefinitionDigest,
  type RoutineProvisionCommand, type ProvisionObservation } from "@grokbox/runtime-kernel/routines";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { GatewayClient, Discovery } from "./gateway.ts";
import { CliError } from "./errors.ts";

export function provisionCliError(error: unknown, command?: RoutineProvisionCommand): CliError {
  const reason = error instanceof RoutineProvisionError ? error.reason : "source_unavailable";
  return new CliError(reason === "outcome_unknown" ? "operation_outcome_unknown"
    : ["invalid_input", "confirmation_required", "revision_conflict", "operation_conflict"].includes(reason) ? "invalid_usage" : "capability_unavailable",
    `Routine provisioning stopped: ${reason}.`, { next: "Read routines outcome for this exact operation. Do not retry an unknown creation with a new operation ID.",
      ...(command ? { context: { operationId: command.operationId, object: { id: command.agentId, kind: "agent" }, phase: "routine-provision" } } : {}) });
}
export async function executeRoutineProvision(client: GatewayClient, command: RoutineProvisionCommand, durableRoot: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = performance.now() + timeoutMs; let discovery: Discovery | undefined;
  const budget = () => { const left = Math.floor(deadline - performance.now()); if (left < 1 || signal?.aborted) throw new RoutineProvisionError("source_unavailable"); return left; };
  const decode = (response: { result: unknown; discovery: Discovery }): ProvisionObservation => {
    discovery = response.discovery;
    const catalog = projectNativeRoutines(command.agentId, response.result), definitions = new Map<string, string>();
    for (const value of response.result as Record<string, unknown>[]) {
      try { definitions.set(String(value.id), observedRoutineDefinitionDigest({ name: value.name, prompt: value.prompt, trigger: value.trigger, isEnabled: value.isEnabled })); }
      catch { /* Unrelated unsupported/native-enabled definitions are not eligible. */ }
    }
    return { catalog, definitions, generation: sha256Text(canonicalJson([discovery.baseUrl, discovery.pid, discovery.startedAt])) };
  };
  try {
    const result = await runRoutineProvisionCommand({ durableRoot, command, signal, native: {
      list: async agentId => decode(await client.rpc("getAgentAutomations", { id: agentId }, { timeoutMs: budget(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES })),
      write: async (agentId, blueprint, id) => decode(await client.rpc(id === null ? "createAgentAutomation" : "updateAgentAutomation",
        { id: agentId, ...(id === null ? {} : { automationId: id }), spec: nativeRoutineSpec(blueprint) },
        { timeoutMs: budget(), write: true, unknownOutcomeCode: "operation_outcome_unknown", maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES })),
    } });
    return { result, discovery };
  } catch (e) { throw provisionCliError(e, command); }
}
