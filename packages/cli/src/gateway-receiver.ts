import { NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { RECEIVER_NOTICE_POLICY_REVISION } from "@grokbox/runtime-kernel/observation";
import type { ReceiverNativeReader, ExplicitReceiverReader } from "@grokbox/box-runtime/runtime";
import { observeHostCapabilitySnapshot } from "./host-capabilities.ts";
import { GatewayClient, type Discovery } from "./gateway.ts";
import type { CliDeps } from "./deps.ts";

const own = (v: unknown, key: string): unknown => v && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined;
const generation = (d: Discovery) => sha256Text(canonicalJson([d.baseUrl, d.pid, d.startedAt]));
/** Only safe read projections cross the runtime port. No credential method,
 * session creation, native run, Provider request or raw prompt is returned. */
export function nativeReceiverReader(deps: CliDeps, timeoutMs: number): ReceiverNativeReader {
  return async (agentId, routineId, signal) => {
    const deadline = performance.now() + Math.min(timeoutMs, 15000);
    const remaining = () => {
      const ms = Math.floor(deadline - performance.now());
      if (ms < 1 || signal?.aborted) throw new Error("receiver_read_unavailable");
      return Math.min(ms, 5000);
    };
    const client = new GatewayClient({ ...deps, transport: "local", signal });
    const routines = await client.rpc("getAgentAutomations", { id: agentId }, { timeoutMs: remaining(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES });
    const catalog = projectNativeRoutines(agentId, routines.result);
    const raw = Array.isArray(routines.result) ? routines.result.find(r => own(r, "id") === routineId) : undefined;
    const prompt = own(raw, "prompt");
    const promptPolicyRevision = typeof prompt === "string" && prompt.length <= 128 * 1024 ? sha256Text(prompt) : null;
    const host = await observeHostCapabilitySnapshot({ ...deps, signal }, remaining(), agentId);
    return { snapshot: { catalog, generation: generation(routines.discovery) }, promptPolicyRevision,
      model: host.receiverModel, capabilities: host.capabilities,
      consistentGeneration: host.gatewayGeneration !== null && host.gatewayGeneration === generation(routines.discovery) };
  };
}

/** Explicit send additionally checks Server ownership with the existing Host
 * reader. This is a read, not a harness/claim mutation or a new model request. */
export function nativeExplicitReceiverReader(deps: CliDeps, timeoutMs: number): ExplicitReceiverReader {
  return async (agentId, routineId, signal) => {
    const deadline = performance.now() + Math.min(timeoutMs, 15000);
    const remaining = () => {
      const left = Math.floor(deadline - performance.now());
      if (left < 1 || signal?.aborted) throw new Error("receiver_read_unavailable");
      return Math.min(left, 5000);
    };
    const receiver = await nativeReceiverReader(deps, remaining())(agentId, routineId, signal);
    if (!receiver.consistentGeneration || receiver.capabilities.state !== "ready" || receiver.model?.state !== "observed"
      || receiver.promptPolicyRevision !== RECEIVER_NOTICE_POLICY_REVISION)
      return { ...receiver, ownership: null, ownershipGeneration: receiver.snapshot.generation };
    const reply = await new GatewayClient({ ...deps, transport: "local", signal }).rpc("getHostStatus",
      { grokboxOwnershipAgentIds: [agentId] }, { timeoutMs: remaining(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES });
    return { ...receiver, ownership: own(reply.result, "grokboxOwnership"), ownershipGeneration: generation(reply.discovery) };
  };
}
