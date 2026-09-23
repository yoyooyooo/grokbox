import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { currentStateRpcRequest, MAX_CURRENT_STATE_WIRE_BYTES, CurrentStateFailure, type CurrentStateRpcRequest } from "@grokbox/runtime-kernel/continuity";
import { validateRoutineCommand, validateProvisionCommand, type RoutineCommand } from "@grokbox/runtime-kernel/routines";
import { createRoutineGateway, type RoutineRpc } from "./routine-gateway.node.ts";
import type { OwnershipReader } from "./ownership-admission.node.ts";

export type ContinuityPrograms = {
  routineProvision: (input: { durableRoot:string; command:unknown; native:ReturnType<ReturnType<typeof createRoutineGateway>>; signal:AbortSignal }) => Promise<unknown>;
  agentRoutines: (input: { command:RoutineCommand; native:ReturnType<ReturnType<typeof createRoutineGateway>>; signal:AbortSignal }) => Promise<unknown>;
};
export type ContinuityDiscovery = { baseUrl: string; pid: number; startedAt: number };
export type ContinuityRpc = Exclude<RoutineRpc, "getAutomationWebhookCredential"> | "listAgents" | "getHostStatus"
  | "getAgentTranscriptTail" | "grokboxCurrentStateControl"
  | "getHostSettings" | "setHostSettings" | "assignAgentToSidebarSection" | "updateAgent" | "setGroupMembers" | "sendPrompt";
export type ContinuityCall = (method: ContinuityRpc | "grokboxContextControl", input: Record<string, unknown>, signal: AbortSignal, timeoutMs: number,
  maxBytes: number, expectedGeneration?: string, beforeDispatch?: (signal: AbortSignal) => Promise<void>) => Promise<{ result: unknown; source: ContinuityDiscovery }>;
export type ContinuityRpcOptions = {
  timeoutMs: number;
  maxResponseBytes?: number;
  write?: boolean;
  singleAttempt?: boolean;
  unknownOutcomeCode?: "operation_outcome_unknown";
  /** Bind a write to the discovery generation already read for this operation. */
  expectedGeneration?: string;
  /** Trusted in-process capability; never serialized into native request input. */
  beforeDispatch?: (signal: AbortSignal) => Promise<void>;
};
export type ContinuityGateway = {
  /** Management-owned manual maintenance. Not advertised by the old CLI RPC client. */
  maintenanceControl?: (input: Record<string, unknown>, options: ContinuityRpcOptions) => Promise<{ result: unknown; discovery: ContinuityDiscovery }>;
  rpc: (method: ContinuityRpc, input: Record<string, unknown>, options: ContinuityRpcOptions) => Promise<{ result: unknown; discovery: ContinuityDiscovery }>;
  listAgents: (timeoutMs: number) => Promise<{ agents: unknown[]; discovery: ContinuityDiscovery }>;
  getAgentOwnership: (ids: string[], timeoutMs: number, localOnly?: boolean) => Promise<{ result: unknown; discovery: ContinuityDiscovery }>;
  currentStateControl: (input: CurrentStateRpcRequest, timeoutMs: number) => Promise<{ result: unknown; discovery: ContinuityDiscovery }>;
  routineProvision: (input: unknown, timeoutMs: number) => Promise<{ result: unknown; discovery?: ContinuityDiscovery }>;
  agentRoutines: (input: RoutineCommand, timeoutMs: number) => Promise<{ result: unknown; discovery: ContinuityDiscovery }>;
};
export type NativeContinuityContext = {
  boxRuntimeRoot: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch; signal?: AbortSignal;
  gateway: () => ContinuityGateway; ownershipRead: OwnershipReader;
};
const uuid = (id: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
const generation = (source: ContinuityDiscovery) => sha256Text(canonicalJson([source.baseUrl, source.pid, source.startedAt]));
const allowed = new Set<ContinuityRpc>(["listAgents", "getHostStatus", "getAgentTranscriptTail", "grokboxCurrentStateControl",
  "getAgentAutomations", "createAgentAutomation", "updateAgentAutomation", "setAgentAutomationEnabled", "deleteAgentAutomation",
  "getHostSettings", "setHostSettings", "assignAgentToSidebarSection", "updateAgent", "setGroupMembers", "sendPrompt"]);

/** Internal capability, not a public RPC proxy. One native generation is pinned
 * before later reads and writes. No credential minting, off-Box fallback or
 * transport retry; the CONT/provision owners reserve every external effect. */
export function createContinuityGatewayIO(call: ContinuityCall, root: string, signal: AbortSignal, programs: ContinuityPrograms): ContinuityGateway {
  let pinned: string | undefined, latest: ContinuityDiscovery | undefined;
  const invoke: ContinuityCall = async (method, input, owner, timeoutMs, maxBytes, expected, beforeDispatch) => {
    if (method !== "grokboxContextControl" && !allowed.has(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > (method === "grokboxCurrentStateControl" ? MAX_CURRENT_STATE_WIRE_BYTES : 2 * 1024 * 1024)) throw new CurrentStateFailure("invalid_request");
    if (expected !== undefined && pinned !== undefined && expected !== pinned) throw new CurrentStateFailure("source_changed");
    const bounded = AbortSignal.any([signal, owner, AbortSignal.timeout(timeoutMs)]);
    bounded.throwIfAborted();
    const result = await call(method, input, bounded, timeoutMs, maxBytes, pinned ?? expected, beforeDispatch);
    const observed = generation(result.source);
    if (pinned !== undefined && pinned !== observed || expected !== undefined && expected !== observed) throw new CurrentStateFailure("source_changed");
    pinned = observed;
    // Do not carry the discovery credential into the shared adapters.
    latest = { baseUrl: result.source.baseUrl, pid: result.source.pid, startedAt: result.source.startedAt };
    return { result: result.result, source: latest };
  };
  const rpc: ContinuityGateway["rpc"] = async (method, input, options) => {
    if (!allowed.has(method)) throw new CurrentStateFailure("invalid_request");
    const reply = await invoke(method, input, signal, options.timeoutMs, options.maxResponseBytes ?? 512 * 1024, options.expectedGeneration, options.beforeDispatch);
    return { result: reply.result, discovery: reply.source };
  };
  const routine = (owner: AbortSignal) => createRoutineGateway(async (method, input, signal, deadline, bytes, expected) => {
    if (method === "getAutomationWebhookCredential") throw new CurrentStateFailure("invalid_request");
    return invoke(method, input, signal, deadline, bytes, expected);
  })(owner);
  const operationSignal = (timeoutMs: number) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new CurrentStateFailure("invalid_request");
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  };
  return {
    rpc,
    maintenanceControl: async (input, options) => {
      if (!["status", "compact"].includes(String(input.action)) || Buffer.byteLength(JSON.stringify(input)) > 4096
        || options.maxResponseBytes !== 65536) throw new CurrentStateFailure("invalid_request");
      const reply = await invoke("grokboxContextControl", input, signal, options.timeoutMs, 65536);
      return { result: reply.result, discovery: reply.source };
    },
    listAgents: async timeoutMs => {
      const reply = await rpc("listAgents", {}, { timeoutMs, maxResponseBytes: 2 * 1024 * 1024 });
      if (!Array.isArray(reply.result) || reply.result.length > 4096) throw new CurrentStateFailure("material_invalid");
      return { agents: reply.result, discovery: reply.discovery };
    },
    getAgentOwnership: async (ids, timeoutMs, localOnly = false) => {
      if (ids.length < 1 || ids.length > 32 || ids.some(id => !uuid(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new CurrentStateFailure("invalid_request");
      const reply = await rpc("getHostStatus", { grokboxOwnershipAgentIds: ids, ...(localOnly ? { grokboxOwnershipLocalOnly: true } : {}) }, { timeoutMs });
      const result = reply.result as Record<string, unknown> | null;
      if (!result || typeof result !== "object" || !Object.hasOwn(result, "grokboxOwnership")) throw new CurrentStateFailure("native_unavailable");
      return { result: result.grokboxOwnership, discovery: reply.discovery };
    },
    currentStateControl: async (raw, timeoutMs) => {
      const input = currentStateRpcRequest(raw);
      if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_CURRENT_STATE_WIRE_BYTES) throw new CurrentStateFailure("material_invalid");
      return rpc("grokboxCurrentStateControl", input as unknown as Record<string, unknown>, { timeoutMs, maxResponseBytes: MAX_CURRENT_STATE_WIRE_BYTES });
    },
    routineProvision: async (raw, timeoutMs) => {
      const owner = operationSignal(timeoutMs);
      const command = validateProvisionCommand(raw), native = routine(owner);
      const result = await programs.routineProvision({ durableRoot: root, command, native, signal: owner });
      return { result, ...(latest ? { discovery: latest } : {}) };
    },
    agentRoutines: async (raw, timeoutMs) => {
      const owner = operationSignal(timeoutMs);
      const command = validateRoutineCommand(raw), native = routine(owner);
      const result = await programs.agentRoutines({ command, native, signal: owner });
      if (!latest) throw new CurrentStateFailure("native_unavailable");
      return { result, discovery: latest };
    },
  };
}
