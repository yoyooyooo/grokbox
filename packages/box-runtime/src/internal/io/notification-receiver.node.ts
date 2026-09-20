import { assessLoadedHostCapabilities, type LoadedHostIdentity } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { projectReceiverModelObservation, RECEIVER_NOTICE_POLICY_REVISION } from "@grokbox/runtime-kernel/observation";

export type ReceiverReadMethod = "getAgentAutomations" | "getHostStatus";
export type ReceiverReadPorts = {
  readProfile: () => Promise<unknown>;
  call: (method: ReceiverReadMethod, input: Record<string, unknown>, signal: AbortSignal, timeoutMs: number) => Promise<{
    result: unknown; source: { baseUrl: string; pid: number; startedAt: number };
  }>;
};
const own = (value: unknown, key: string): unknown => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// Existing native pairing identity. The public Bot membership generation uses
// a different projection and must not be substituted into retained bindings.
const generation = (source: { baseUrl: string; pid: number; startedAt: number }) => sha256Text(canonicalJson([source.baseUrl, source.pid, source.startedAt]));
function profile(value: unknown): Pick<LoadedHostIdentity, "profileSha256" | "sourceSha256" | "transformedSha256"> {
  const source = own(value, "sourceSha256"), transformed = own(value, "transformedSourceSha256");
  if (!hash(source) || !hash(transformed) || !Array.isArray(own(value, "slices"))) throw Error("receiver_profile_unavailable");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("receiver_profile_unavailable");
  return { profileSha256: sha256Text(`${serialized}\n`), sourceSha256: source, transformedSha256: transformed };
}

/** Shared narrow native read sequence for management workers and remaining CLI
 * callers. It never acquires a webhook key, creates a session, enables a Routine,
 * invokes a provider or returns prompt text. Both consumers use the same facts. */
export function createNotificationReceiver(ports: ReceiverReadPorts, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw Error("receiver_invalid_deadline");
  const observe = async (agentId: string, routineId: string, parent: AbortSignal | undefined, explicit: boolean) => {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(agentId)
      || typeof routineId !== "string" || !routineId || routineId.length > 256 || /[\x00-\x1f\x7f]/.test(routineId)) throw Error("receiver_invalid_target");
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const deadline = performance.now() + timeoutMs;
    const call = async (method: ReceiverReadMethod, args: Record<string, unknown>) => {
      signal.throwIfAborted();
      const remaining = Math.min(5000, Math.floor(deadline - performance.now()));
      if (remaining < 1) throw Error("receiver_read_unavailable");
      const result = await ports.call(method, args, signal, remaining);
      signal.throwIfAborted();
      // Ports must bound raw responses before buffering. This check also guards
      // in-process adapters and never includes the body in diagnostics.
      if (Buffer.byteLength(JSON.stringify(result.result)) > NATIVE_ROUTINE_MAX_BYTES) throw Error("receiver_source_oversized");
      return result;
    };
    signal.throwIfAborted();
    const before = profile(await ports.readProfile());
    signal.throwIfAborted();
    const routines = await call("getAgentAutomations", { id: agentId });
    const catalog = projectNativeRoutines(agentId, routines.result);
    const raw = Array.isArray(routines.result) ? routines.result.find(row => own(row, "id") === routineId) : undefined;
    const prompt = own(raw, "prompt");
    const promptPolicyRevision = typeof prompt === "string" && prompt.length <= 128 * 1024 ? sha256Text(prompt) : null;
    const host = await call("getHostStatus", { grokboxRuntimeCapabilities: true, grokboxOwnershipAgentIds: [agentId], grokboxOwnershipLocalOnly: true });
    const after = profile(await ports.readProfile());
    signal.throwIfAborted();
    if (before.profileSha256 !== after.profileSha256) return { snapshot: { catalog, generation: generation(routines.source) }, promptPolicyRevision,
      capabilities: { state: "unavailable" as const, reason: "expected_profile_unavailable" as const }, model: null,
      consistentGeneration: false, ownership: null, ownershipGeneration: generation(routines.source) };
    const receiver = { snapshot: { catalog, generation: generation(routines.source) }, promptPolicyRevision,
      model: projectReceiverModelObservation(own(host.result, "grokboxReceiverModel"), agentId, Date.now()),
      capabilities: assessLoadedHostCapabilities(own(host.result, "grokboxRuntimeCapabilities"), { gatewayPid: host.source.pid, profile: after }),
      consistentGeneration: generation(host.source) === generation(routines.source) };
    if (!explicit || !receiver.consistentGeneration || receiver.capabilities.state !== "ready" || receiver.model?.state !== "observed"
      || receiver.promptPolicyRevision !== RECEIVER_NOTICE_POLICY_REVISION) return { ...receiver, ownership: null, ownershipGeneration: receiver.snapshot.generation };
    const ownership = await call("getHostStatus", { grokboxOwnershipAgentIds: [agentId] });
    return { ...receiver, ownership: own(ownership.result, "grokboxOwnership"), ownershipGeneration: generation(ownership.source) };
  };
  return { read: (agentId: string, routineId: string, signal?: AbortSignal) => observe(agentId, routineId, signal, false),
    readExplicit: (agentId: string, routineId: string, signal?: AbortSignal) => observe(agentId, routineId, signal, true) };
}
