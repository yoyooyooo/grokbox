import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines, nativeRoutineSpec, observedRoutineDefinitionDigest,
  routineAgentId, routineId, RoutineProvisionError, type RoutineBlueprint, type ProvisionObservation } from "@grokbox/runtime-kernel/routines";
import { OPS_PAIRING_POLICY } from "@grokbox/runtime-kernel/observation";

export type RoutineRpc = "getAgentAutomations" | "createAgentAutomation" | "updateAgentAutomation" | "setAgentAutomationEnabled" | "deleteAgentAutomation" | "getAutomationWebhookCredential";
export type RoutineGatewayCall = (method: RoutineRpc, input: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, maxBytes: number, expectedGeneration?: string) => Promise<{
  result: unknown; source: { baseUrl: string; pid: number; startedAt: number };
}>;
export type RoutineAccess = ReturnType<ReturnType<typeof createRoutineGateway>>;
/** One short-lived, pinned native interaction. The caller must reserve its
 * durable domain guard before invoking write/change/credential. No arbitrary
 * RPC, retry, service fallback, key output or webhook invocation is exposed. */
export function createRoutineGateway(call: RoutineGatewayCall) {
  return (signal: AbortSignal) => {
    const deadline = performance.now() + 20_000;
    let generation: string | undefined;
    function remaining() {
      const left = Math.floor(deadline - performance.now());
      if (left < 1 || signal.aborted) throw new RoutineProvisionError("source_unavailable");
      return Math.min(10_000, left);
    }
    async function invoke(method: RoutineRpc, input: Record<string, unknown>, write: boolean, maxBytes = NATIVE_ROUTINE_MAX_BYTES) {
      if (write && !generation) throw new RoutineProvisionError("source_unavailable");
      const reply = await call(method, input, signal, remaining(), maxBytes, generation);
      const observed = sha256Text(canonicalJson([reply.source.baseUrl, reply.source.pid, reply.source.startedAt]));
      if (generation !== undefined && generation !== observed) throw new RoutineProvisionError("source_unavailable");
      generation = observed;
      return reply.result;
    }
    function decode(agentId: string, raw: unknown): ProvisionObservation {
      const catalog = projectNativeRoutines(agentId, raw), definitions = new Map<string, string>();
      for (const row of raw as Record<string, unknown>[]) {
        try { definitions.set(String(row.id), observedRoutineDefinitionDigest({ name: row.name, prompt: row.prompt, trigger: row.trigger, isEnabled: row.isEnabled })); }
        catch { /* Enabled or unsupported native definitions do not qualify a disabled blueprint. */ }
      }
      return { catalog, definitions, generation: generation! };
    }
    return {
      list: async (agentId: string) => decode(routineAgentId(agentId), await invoke("getAgentAutomations", { id: routineAgentId(agentId) }, false)),
      write: async (agentId: string, blueprint: RoutineBlueprint, nativeId: string | null) => decode(routineAgentId(agentId), await invoke(nativeId === null ? "createAgentAutomation" : "updateAgentAutomation",
        { id: routineAgentId(agentId), ...(nativeId === null ? {} : { automationId: routineId(nativeId) }), spec: nativeRoutineSpec(blueprint) }, true)),
      change: async (agentId: string, nativeId: string, action: "enable" | "disable" | "delete") => decode(routineAgentId(agentId), await invoke(action === "delete" ? "deleteAgentAutomation" : "setAgentAutomationEnabled",
        { id: routineAgentId(agentId), automationId: routineId(nativeId), ...(action === "delete" ? {} : { isEnabled: action === "enable" }) }, true)),
      credential: async (agentId: string, nativeId: string) => ({ value: await invoke("getAutomationWebhookCredential", { id: routineAgentId(agentId), automationId: routineId(nativeId) }, true, OPS_PAIRING_POLICY.maxCredentialResponseBytes), generation: generation! }),
    };
  };
}
