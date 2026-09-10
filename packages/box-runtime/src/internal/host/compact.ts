import type { ContextSnapshot, HostCompactRequest, HostCompactResult } from "@grokbox/runtime-kernel/contract";
import { HOST_COMPACT_SYMBOL } from "./profile.ts";
import { hostToContextSnapshot } from "./context-codec.ts";

export { HOST_COMPACT_SYMBOL };

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

let active: CompactSlot | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value)
    ? value
    : undefined;
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

function sameIdentity(slot: CompactSlot, request: HostCompactRequest): boolean {
  return request.tuple.agentId === slot.capture.agentId
    && request.tuple.turnId === slot.capture.turnId
    && request.tuple.stepId === slot.capture.invocationId;
}

function readSnapshot(slot: CompactSlot): ContextSnapshot | undefined {
  if (!slot.profileId || !slot.abiIdentity) return undefined;
  const root = slot.capture.rootPromptExecutor;
  const state = typeof root.getState === "function" ? root.getState() : typeof root.getMessages === "function" ? root.getMessages() : undefined;
  try {
    return hostToContextSnapshot({ profileId: slot.profileId, abiIdentity: slot.abiIdentity, state });
  } catch {
    return undefined;
  }
}

/** Effect-free Host hook. Preload-safe. Returns a disposable for the native env_2 stack. */
export function bindHostCompactHook(options?: {
  profileId?: string;
  abiIdentity?: string;
}): (raw: unknown) => { [Symbol.dispose](): void } | undefined {
  return (raw) => {
    const capture = parseCapture(raw);
    if (!capture) return undefined;
    const slot: CompactSlot = {
      capture,
      profileId: options?.profileId,
      abiIdentity: options?.abiIdentity,
      consumed: false,
      disposed: false,
    };
    active = slot;
    return {
      [Symbol.dispose]() {
        slot.disposed = true;
        if (active === slot) active = undefined;
      },
    };
  };
}

export async function requestHostCompact(input: HostCompactRequest): Promise<HostCompactResult> {
  const slot = active;
  if (!slot || slot.disposed || slot.capture.stepClosed()) return unavailable("capability_not_ready");
  if (!sameIdentity(slot, input)) return unavailable("blocked");
  if (slot.consumed) return unavailable("blocked");
  if (slot.capture.stateHandler.backgroundSummarizationPromiseInfo != null) return unavailable("blocked");
  if (slot.capture.ctx.signal?.aborted === true) return unavailable("cancelled");
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
    if (summary === undefined) return { kind: "no_improvement" };
    const snapshot = readSnapshot(slot);
    if (!snapshot) return { kind: "no_improvement" };
    return { kind: "snapshot", snapshot };
  } catch {
    return unavailable("unknown");
  }
}

export function resetHostCompactSlotForTests(): void {
  active = undefined;
}
