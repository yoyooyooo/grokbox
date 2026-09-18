import { openRuntimeStore, projectLiveStatus, reviewedProfilePath } from "@grokbox/box-runtime/runtime";
import { assessLoadedHostCapabilities, type HostCapabilityReport, type LoadedHostIdentity } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectReceiverModelObservation, type ReceiverModelObservation } from "@grokbox/runtime-kernel/observation";
import type { CliDeps } from "./deps.ts";
import { GatewayClient } from "./gateway.ts";

const unavailable = (): HostCapabilityReport => ({ state: "unavailable", reason: "observation_unavailable" });
const isSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function expectedProfile(bytes: string): Pick<LoadedHostIdentity, "profileSha256" | "sourceSha256" | "transformedSha256"> | undefined {
  if (bytes.length > 1024 * 1024) return undefined;
  try {
    const profile = JSON.parse(bytes);
    if (!isSha(profile?.sourceSha256) || !isSha(profile?.transformedSourceSha256) || !Array.isArray(profile?.slices)) return undefined;
    return { profileSha256: sha256Text(`${JSON.stringify(profile)}\n`), sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 };
  } catch { return undefined; }
}

export type HostCapabilitySnapshot = { capabilities: HostCapabilityReport; gatewayGeneration: string | null; receiverModel: ReceiverModelObservation | null };
/** One local read-only status frame: capabilities and optional receiver preview
 * must share the same Gateway generation. No Server List or Provider request. */
export async function observeHostCapabilitySnapshot(deps: CliDeps, timeoutMs: number, receiverAgentId?: string): Promise<HostCapabilitySnapshot> {
  const empty = (capabilities: HostCapabilityReport = unavailable()): HostCapabilitySnapshot => ({ capabilities, gatewayGeneration: null, receiverModel: null });
  if (deps.daemonServerUrl || deps.gatewayServerUrl || deps.sshHost) return empty();
  if (receiverAgentId !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receiverAgentId)) return empty();
  try {
    const runtime = openRuntimeStore(deps.boxRuntimeRoot, deps.env);
    const path = reviewedProfilePath(runtime.root);
    const before = expectedProfile(await deps.readFile(path));
    if (!before) return empty({ state: "unavailable", reason: "expected_profile_unavailable" });
    const client = new GatewayClient({ ...deps, transport: "local" });
    const reply = await client.rpc("getHostStatus", { grokboxRuntimeCapabilities: true,
      ...(receiverAgentId ? { grokboxOwnershipAgentIds: [receiverAgentId], grokboxOwnershipLocalOnly: true } : {}) },
      { timeoutMs: Math.min(timeoutMs, 5000), maxResponseBytes: 512 * 1024 });
    const after = expectedProfile(await deps.readFile(path));
    if (!after || before.profileSha256 !== after.profileSha256) return empty({ state: "unavailable", reason: "expected_profile_unavailable" });
    const result = reply.result && typeof reply.result === "object" ? reply.result as Record<string, unknown> : {};
    return { capabilities: assessLoadedHostCapabilities(result.grokboxRuntimeCapabilities, { gatewayPid: reply.discovery.pid, profile: after }),
      gatewayGeneration: sha256Text(canonicalJson([reply.discovery.baseUrl, reply.discovery.pid, reply.discovery.startedAt])),
      receiverModel: receiverAgentId ? projectReceiverModelObservation(result.grokboxReceiverModel, receiverAgentId, Date.now()) : null };
  } catch { return empty(); }
}

/** Existing callers retain the narrow capability-only surface. */
export async function observeHostCapabilities(deps: CliDeps, timeoutMs: number): Promise<HostCapabilityReport> {
  return (await observeHostCapabilitySnapshot(deps, timeoutMs)).capabilities;
}

/** Only the controller's committed terminal outcomes qualify. A missing/novel
 * receipt, partial signal or pending attestation is not component alignment. */
export function controllerApplyCompleted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const outcome = Object.getOwnPropertyDescriptor(value, "outcome");
  const reason = Object.getOwnPropertyDescriptor(value, "reason");
  if (!outcome || !("value" in outcome) || !reason || !("value" in reason)) return false;
  return outcome.value === "signaled" && reason.value === null
    || outcome.value === "converged" && reason.value === "duplicate-operation";
}

export type CommittedHostAlignment = {
  state: "ready" | "blocked" | "unavailable";
  reason: "matched" | "bridge_uncommitted" | "recovery_pending" | "modeld_not_ready" | "observation_unavailable";
};

/** Live authority and service proof is separate from a loaded wrapper manifest. */
export function projectCommittedHostAlignment(status: Awaited<ReturnType<typeof projectLiveStatus>>): CommittedHostAlignment {
  const { bridge, recovery, modeld } = status.facets;
  const value = bridge.value;
  if (bridge.gap !== null || !value || value.origin !== "grokbox-attested" || value.reason !== null
    || value.actual !== value.desired || !["route", "identity"].includes(String(value.actual))) {
    return { state: "blocked", reason: "bridge_uncommitted" };
  }
  if (recovery.value?.pending !== false || recovery.gap !== null && recovery.gap !== "missing") {
    return { state: "blocked", reason: "recovery_pending" };
  }
  if (value.actual === "route" && (modeld.gap !== null || modeld.value?.ready !== true || modeld.value.execution?.accepting !== true)) {
    return { state: "blocked", reason: "modeld_not_ready" };
  }
  return { state: "ready", reason: "matched" };
}

async function observeCommittedHostAlignment(deps: CliDeps): Promise<CommittedHostAlignment> {
  if (deps.daemonServerUrl || deps.gatewayServerUrl) return { state: "unavailable", reason: "observation_unavailable" };
  try {
    const runtime = openRuntimeStore(deps.boxRuntimeRoot, deps.env);
    return projectCommittedHostAlignment(await projectLiveStatus({ root: runtime.root,
      ...(deps.env.GROKBOX_RUN_ROOT ? { ephemeralRoot: deps.env.GROKBOX_RUN_ROOT } : {}) }));
  } catch { return { state: "unavailable", reason: "observation_unavailable" }; }
}

export const hostCapabilityPorts = { observe: observeHostCapabilities, alignment: observeCommittedHostAlignment };
