import type { ContextSnapshot, HostCompactRequest, HostCompactResult } from "@grokbox/runtime-kernel/contract";
import { HOST_COMPACT_SYMBOL } from "./profile.ts";
import { hostToContextSnapshot } from "./context-codec.ts";
import { HOST_ROOT_CONTRACTS } from "./root-contract.ts";

export { HOST_COMPACT_SYMBOL };

const MAX_LIVE_SLOTS = 16;

type CompactCapture = {
  orchestrator: { handleSummarization: (...args: unknown[]) => Promise<unknown> };
  ctx: { get?: (key: unknown) => unknown; signal?: { aborted?: boolean } };
  stateHandler: { backgroundSummarizationPromiseInfo?: unknown; lastStepInvocationId?: unknown };
  rootPromptExecutor: { getMessages?: () => unknown; getState?: () => unknown };
  interactionListener: unknown;
  config: unknown;
  requestContext: unknown;
  invocationId: string;
  turnId: string;
  agentId: string;
  resourceAccessor: unknown;
  stepClosed: () => boolean;
};

type CompactSlot = {
  capture: CompactCapture;
  profileId?: string;
  abiIdentity?: string;
  consumed: boolean;
  disposed: boolean;
};

const slots = new Map<string, CompactSlot>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value)
    ? value
    : undefined;
}

function ownerKey(agentId: string, turnId: string, stepId: string): string {
  return `${agentId}\n${turnId}\n${stepId}`;
}

function parseCapture(value: unknown): CompactCapture | undefined {
  if (!record(value)) return undefined;
  const orchestrator = record(value.orchestrator) ? value.orchestrator : undefined;
  if (typeof orchestrator?.handleSummarization !== "function") return undefined;
  if (!record(value.ctx) || !record(value.stateHandler) || !record(value.rootPromptExecutor)) return undefined;
  if (typeof value.stepClosed !== "function") return undefined;
  const invocationId = boundedId(value.invocationId);
  const turnId = boundedId(value.turnId);
  const agentId = boundedId(value.agentId);
  if (!invocationId || !turnId || !agentId) return undefined;
  return {
    orchestrator: orchestrator as CompactCapture["orchestrator"],
    ctx: value.ctx,
    stateHandler: value.stateHandler,
    rootPromptExecutor: value.rootPromptExecutor,
    interactionListener: value.interactionListener,
    config: value.config,
    requestContext: value.requestContext,
    invocationId,
    turnId,
    agentId,
    resourceAccessor: value.resourceAccessor,
    stepClosed: value.stepClosed as () => boolean,
  };
}

function unavailable(reason: "capability_not_ready" | "blocked" | "cancelled" | "unknown"): HostCompactResult {
  return { kind: "unavailable", reason };
}

function snapshotQualified(profileId: string | undefined, abiIdentity: string | undefined): boolean {
  if (!profileId || !abiIdentity) return false;
  return HOST_ROOT_CONTRACTS.some((row) =>
    row.profileId === profileId && row.abiIdentity === abiIdentity && row.rootSource === "state-system");
}

function unqualifiedResourceChain(config: unknown, requestContext: unknown): boolean {
  if (record(config) && config.getNamedAgentSelfDocument !== undefined) return true;
  if (!record(config) || config.enableExecuteHookExec !== true) return false;
  const hooks = record(requestContext) && record(requestContext.hooksConfig) ? requestContext.hooksConfig : undefined;
  const steps = hooks && Array.isArray(hooks.configuredSteps) ? hooks.configuredSteps : [];
  return steps.includes("preCompact");
}

function slotInvalid(slot: CompactSlot): boolean {
  return slot.disposed || slot.capture.stepClosed();
}

function signalAborted(ctx: CompactCapture["ctx"]): boolean {
  return ctx.signal?.aborted === true;
}

function readSnapshot(slot: CompactSlot): ContextSnapshot | undefined {
  if (!snapshotQualified(slot.profileId, slot.abiIdentity) || !slot.profileId || !slot.abiIdentity) return undefined;
  const root = slot.capture.rootPromptExecutor;
  const state = typeof root.getState === "function" ? root.getState() : typeof root.getMessages === "function" ? root.getMessages() : undefined;
  try {
    return hostToContextSnapshot({ profileId: slot.profileId, abiIdentity: slot.abiIdentity, state });
  } catch {
    return undefined;
  }
}

function lookup(input: HostCompactRequest): CompactSlot | undefined {
  return slots.get(ownerKey(input.tuple.agentId, input.tuple.turnId, input.tuple.stepId));
}

/** Effect-free Host hook. Preload-safe. Returns a disposable for the native env_2 stack. */
export function bindHostCompactHook(options?: {
  profileId?: string;
  abiIdentity?: string;
}): (raw: unknown) => { [Symbol.dispose](): void } | undefined {
  return (raw) => {
    const capture = parseCapture(raw);
    if (!capture) return undefined;
    const key = ownerKey(capture.agentId, capture.turnId, capture.invocationId);
    const existing = slots.get(key);
    if (existing && !existing.disposed) return undefined;
    if (slots.size >= MAX_LIVE_SLOTS && !existing) return undefined;
    const slot: CompactSlot = {
      capture,
      profileId: options?.profileId,
      abiIdentity: options?.abiIdentity,
      consumed: false,
      disposed: false,
    };
    slots.set(key, slot);
    return {
      [Symbol.dispose]() {
        slot.disposed = true;
        if (slots.get(key) === slot) slots.delete(key);
      },
    };
  };
}

export async function requestHostCompact(input: HostCompactRequest): Promise<HostCompactResult> {
  const slot = lookup(input);
  if (!slot || slotInvalid(slot)) return unavailable("capability_not_ready");
  if (slot.consumed) return unavailable("blocked");
  if (!snapshotQualified(slot.profileId, slot.abiIdentity)) return unavailable("capability_not_ready");
  if (unqualifiedResourceChain(slot.capture.config, slot.capture.requestContext)) return unavailable("blocked");
  if (slot.capture.stateHandler.backgroundSummarizationPromiseInfo != null) return unavailable("blocked");
  if (signalAborted(slot.capture.ctx)) return unavailable("cancelled");
  slot.consumed = true;
  try {
    const summary = await slot.capture.orchestrator.handleSummarization(
      slot.capture.ctx,
      slot.capture.stateHandler,
      slot.capture.rootPromptExecutor,
      slot.capture.interactionListener,
      slot.capture.config,
      slot.capture.requestContext,
      {
        backgroundSummarizationMode: "WaitForCompletion",
        forceExternalModel: true,
        triggerReason: "input_token_limit_error",
        currentInvocationId: slot.capture.invocationId,
        resourceAccessor: slot.capture.resourceAccessor,
      },
    );
    if (signalAborted(slot.capture.ctx)) return unavailable("cancelled");
    if (slotInvalid(slot)) return unavailable("unknown");
    const last = slot.capture.stateHandler.lastStepInvocationId;
    if (last !== undefined && last !== slot.capture.invocationId) return unavailable("unknown");
    if (summary === undefined) return { kind: "no_improvement" };
    const snapshot = readSnapshot(slot);
    if (!snapshot) return { kind: "no_improvement" };
    return { kind: "snapshot", snapshot };
  } catch {
    return unavailable("unknown");
  }
}

export function resetHostCompactSlotForTests(): void {
  slots.clear();
}
