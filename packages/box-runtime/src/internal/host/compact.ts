import { REQUEST_WALL_DEADLINE_MS, type ContextSnapshot, type HostCompactRequest, type HostCompactResult } from "@grokbox/runtime-kernel/contract";
import { HOST_COMPACT_SYMBOL } from "./profile.ts";
import { hostToContextSnapshot } from "./context-codec.ts";
import { HOST_ROOT_CONTRACTS } from "./root-contract.ts";
import { recordHostManagedFailure } from "./session.ts";

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
  managed: boolean;
};

const slots = new Map<string, CompactSlot>();
// A root may be reused by the next native STEP before a late summary settles.
// Tuple lookup alone cannot fence an older scope retaining that same mutable root.
let rootOwners = new WeakMap<object, CompactSlot>();

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

/** Snapshot codec identity for managed STEPs. Not the Host patch profileId. Omitted bind stays unqualified. */
export function stateSystemCompactHookOptions(): { profileId: string; abiIdentity: string } | undefined {
  const row = HOST_ROOT_CONTRACTS.find((item) => item.rootSource === "state-system");
  return row ? { profileId: row.profileId, abiIdentity: row.abiIdentity } : undefined;
}

function unqualifiedResourceChain(config: unknown, requestContext: unknown): boolean {
  if (record(config) && config.getNamedAgentSelfDocument !== undefined) return true;
  if (!record(config) || config.enableExecuteHookExec !== true) return false;
  const hooks = record(requestContext) && record(requestContext.hooksConfig) ? requestContext.hooksConfig : undefined;
  const steps = hooks && Array.isArray(hooks.configuredSteps) ? hooks.configuredSteps : [];
  return steps.includes("preCompact");
}

function slotInvalid(slot: CompactSlot): boolean {
  return slot.disposed || slot.capture.stepClosed()
    || rootOwners.get(slot.capture.rootPromptExecutor) !== slot;
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
      managed: false,
    };
    slots.set(key, slot);
    rootOwners.set(capture.rootPromptExecutor, slot);
    return {
      [Symbol.dispose]() {
        slot.disposed = true;
        if (slots.get(key) === slot) slots.delete(key);
        if (rootOwners.get(capture.rootPromptExecutor) === slot) rootOwners.delete(capture.rootPromptExecutor);
      },
    };
  };
}

/** Called by the real managed stream entry, never inferred from model names or message text. */
export function noteHostManagedStep(input: { agentId: string; turnId: string; stepId: string }): boolean {
  const slot = slots.get(ownerKey(input.agentId, input.turnId, input.stepId));
  if (!slot || slotInvalid(slot) || signalAborted(slot.capture.ctx)) return false;
  slot.managed = true;
  return true;
}

/** Only the root currently executing an actual managed stream suspends native mid-STEP summaries. */
export function isHostManagedRootActive(root: unknown): boolean {
  for (const slot of slots.values()) {
    if (slot.managed && slot.capture.rootPromptExecutor === root && !slotInvalid(slot) && !signalAborted(slot.capture.ctx)) return true;
  }
  return false;
}

/** Native post-stream/tool/checkpoint failures belong to the same active managed STEP.
 * Do not relabel official work, a released root, or errors merely carrying matching text.
 */
export function recordHostManagedStepFailure(root: unknown, error: unknown): boolean {
  return isHostManagedRootActive(root) && recordHostManagedFailure(error);
}

export type CompactInFlight = {
  agentId: string;
  turnId: string;
  stepId: string;
  selectionRevision: string;
  bindingId?: string;
};

export type HostCompactLifetime = {
  /** The originating socket/STEP, not a fresh independent timeout per phase. */
  stopped?: () => boolean;
  /** Remaining duration; never a monotonic timestamp from another process. */
  deadlineMs?: number;
  now?: () => number;
};

/** Keep native receivers and chaining; every delegated access/write rechecks the live lease.
 * This fences the Host root/state boundary, not external archive/provider effects already begun.
 * The qualified native root mutators are synchronous; async work must re-enter through this facade.
 */
function guardedCompactOwner<T extends object>(target: T, assertCurrent: () => void): T {
  const methods = new Map<PropertyKey, { source: Function; guarded: Function }>();
  const proxy = new Proxy(target, {
    get(owner, key) {
      assertCurrent();
      const value = Reflect.get(owner, key, owner);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached?.source === value) return cached.guarded;
      const guarded = (...args: unknown[]) => {
        assertCurrent();
        const result = Reflect.apply(value, owner, args);
        return result === owner ? proxy : result;
      };
      methods.set(key, { source: value, guarded });
      return guarded;
    },
    set(owner, key, value) { assertCurrent(); return Reflect.set(owner, key, value, owner); },
    defineProperty(owner, key, descriptor) { assertCurrent(); return Reflect.defineProperty(owner, key, descriptor); },
    deleteProperty(owner, key) { assertCurrent(); return Reflect.deleteProperty(owner, key); },
  });
  return proxy;
}

export type CompactControlIdentity = {
  deadlineMs?: number;
  agentId: string;
  turnId: string;
  stepId: string;
  bindingId: string;
  selectionRevision: string;
  recoveryNonce: string;
};

export type ResumeStepFrame = CompactControlIdentity & {
  version: 4;
  method: "resume-step";
  snapshot: ContextSnapshot;
};

export function compactControlMatchesInFlight(control: CompactControlIdentity, inFlight: CompactInFlight | undefined): boolean {
  if (!inFlight) return false;
  if (!control.recoveryNonce) return false;
  if (control.agentId !== inFlight.agentId) return false;
  if (control.turnId !== inFlight.turnId) return false;
  if (control.stepId !== inFlight.stepId) return false;
  if (control.selectionRevision !== inFlight.selectionRevision) return false;
  if (inFlight.bindingId !== undefined && control.bindingId !== inFlight.bindingId) return false;
  return true;
}

/** Same-connection resume-step. Echoes compact-request tuple/nonce; never invents a second STEP. */
export async function resumeStepFrameForCompactRequest(
  control: CompactControlIdentity,
  inFlight: CompactInFlight | undefined,
  lifetime: HostCompactLifetime = {},
): Promise<ResumeStepFrame | undefined> {
  if (!compactControlMatchesInFlight(control, inFlight)) return undefined;
  const result = await requestHostCompact({
    tuple: {
      agentId: control.agentId,
      turnId: control.turnId,
      stepId: control.stepId,
      bindingId: control.bindingId,
      selectionRevision: control.selectionRevision,
    },
    recoveryNonce: control.recoveryNonce,
  }, {
    ...lifetime,
    deadlineMs: Math.min(control.deadlineMs ?? REQUEST_WALL_DEADLINE_MS, lifetime.deadlineMs ?? REQUEST_WALL_DEADLINE_MS),
  });
  if (result.kind !== "snapshot") return undefined;
  return {
    version: 4,
    method: "resume-step",
    agentId: control.agentId,
    turnId: control.turnId,
    stepId: control.stepId,
    bindingId: control.bindingId,
    selectionRevision: control.selectionRevision,
    recoveryNonce: control.recoveryNonce,
    snapshot: result.snapshot,
  };
}

export async function requestHostCompact(input: HostCompactRequest, lifetime: HostCompactLifetime = {}): Promise<HostCompactResult> {
  const now = lifetime.now ?? (() => performance.now());
  const budget = lifetime.deadlineMs ?? REQUEST_WALL_DEADLINE_MS;
  if (!Number.isFinite(budget) || budget <= 0 || budget > REQUEST_WALL_DEADLINE_MS || lifetime.stopped?.()) {
    return unavailable("cancelled");
  }
  const deadline = now() + budget;
  const slot = lookup(input);
  if (!slot || slotInvalid(slot)) return unavailable("capability_not_ready");
  if (slot.consumed) return unavailable("blocked");
  if (!snapshotQualified(slot.profileId, slot.abiIdentity)) return unavailable("capability_not_ready");
  if (unqualifiedResourceChain(slot.capture.config, slot.capture.requestContext)) return unavailable("blocked");
  if (slot.capture.stateHandler.backgroundSummarizationPromiseInfo != null) return unavailable("blocked");
  const cancelled = () => signalAborted(slot.capture.ctx) || lifetime.stopped?.() === true || now() >= deadline;
  if (cancelled()) return unavailable("cancelled");
  let delegateOpen = true;
  const assertCurrent = () => {
    const last = slot.capture.stateHandler.lastStepInvocationId;
    if (!delegateOpen || cancelled() || slotInvalid(slot) || slots.get(ownerKey(input.tuple.agentId, input.tuple.turnId, input.tuple.stepId)) !== slot
      || (last !== undefined && last !== slot.capture.invocationId)) {
      throw new Error("host_compact_lease_expired");
    }
  };
  try {
    // Stale identity is a pre-invocation refusal, not a check deferred until after
    // a provider/archive effect or the first access through a guarded receiver.
    assertCurrent();
    slot.consumed = true;
    const summary = await slot.capture.orchestrator.handleSummarization(
      slot.capture.ctx,
      guardedCompactOwner(slot.capture.stateHandler, assertCurrent),
      guardedCompactOwner(slot.capture.rootPromptExecutor, assertCurrent),
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
    assertCurrent();
    if (summary === undefined) return { kind: "no_improvement" };
    const snapshot = readSnapshot(slot);
    if (!snapshot) return { kind: "no_improvement" };
    return { kind: "snapshot", snapshot };
  } catch {
    return unavailable(cancelled() ? "cancelled" : "unknown");
  } finally {
    // Native callbacks retaining the facade cannot mutate the root after this
    // compact result, even while the enclosing STEP/attempt1 is still active.
    delegateOpen = false;
  }
}

export function resetHostCompactSlotForTests(): void {
  slots.clear();
  rootOwners = new WeakMap<object, CompactSlot>();
}
