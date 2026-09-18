import { runAgentRoutineCommand } from "@grokbox/box-runtime/runtime";
import { RoutineError, NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines, type RoutineCommand, type RoutineSnapshot } from "@grokbox/runtime-kernel/routines";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { Discovery, GatewayClient } from "./gateway.ts";
import { CliError } from "./errors.ts";

export function routineCliError(error: unknown, command?: RoutineCommand): CliError {
  if (error instanceof CliError) return error;
  const reason = error instanceof RoutineError ? error.reason : "read_unavailable";
  const code = reason === "outcome_unknown" ? "operation_outcome_unknown"
    : ["invalid_input", "confirmation_required", "revision_conflict"].includes(reason) ? "invalid_usage" : "capability_unavailable";
  return new CliError(code, `Routine operation stopped: ${reason}.`, {
    ...(reason === "outcome_unknown" ? { next: "Read the exact Agent/Routine again and reconcile; do not automatically replay this operation." } : {}),
    ...(command?.operationId ? { context: { operationId: command.operationId, phase: "native-routine" } } : {}),
  });
}
/** Adapter uses only qualified management RPCs. Credential retrieval is NOT a
 * read: it may mint a key, so it and runNow/invoke are intentionally absent. */
export async function executeNativeRoutine(client: GatewayClient, command: RoutineCommand, timeoutMs: number, signal?: AbortSignal) {
  const deadline = performance.now() + timeoutMs;
  let discovery: Discovery | undefined;
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1 || signal?.aborted) throw new RoutineError("read_unavailable");
    return left;
  };
  const decode = (value: { result: unknown; discovery: Discovery }): RoutineSnapshot => {
    discovery = value.discovery;
    return { catalog: projectNativeRoutines(command.agentId, value.result),
      generation: sha256Text(canonicalJson([discovery.baseUrl, discovery.pid, discovery.startedAt])) };
  };
  try {
    const result = await runAgentRoutineCommand({ command, signal, native: {
      list: async agentId => decode(await client.rpc("getAgentAutomations", { id: agentId }, { timeoutMs: remaining(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES })),
      change: async (agentId, routineId, action) => decode(await client.rpc(action === "delete" ? "deleteAgentAutomation" : "setAgentAutomationEnabled",
        { id: agentId, automationId: routineId, ...(action === "delete" ? {} : { isEnabled: action === "enable" }) },
        { timeoutMs: remaining(), write: true, unknownOutcomeCode: "operation_outcome_unknown", maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES })),
    } });
    if (!discovery) throw new RoutineError("read_unavailable");
    return { result, discovery };
  } catch (e) { throw routineCliError(e, command); }
}

/** Bounded, strict UTF-8 body decoding before JSON/projection. Never keep reading
 * an unlimited native response just to produce a small final summary. */
export async function boundedGatewayBody(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_ROUTINE_MAX_BYTES) throw new CliError("gateway_internal", "Invalid response budget.");
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined); throw new CliError("gateway_internal", "Gateway response exceeds the allowed byte budget.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let used = 0, text = "";
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      used += item.value.byteLength;
      if (used > maxBytes) throw new CliError("gateway_internal", "Gateway response exceeds the allowed byte budget.");
      text += decoder.decode(item.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
