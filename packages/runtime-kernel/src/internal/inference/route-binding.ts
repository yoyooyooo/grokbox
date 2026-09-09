import { Context, Deferred, Layer, SynchronizedRef } from "effect";
import type * as Scope from "effect/Scope";
import { canonicalJson, sha256Text } from "../../hash.ts";
import { LEDGER_ENTRIES_MAX, TURN_IDLE_MS } from "../contract/limits.ts";
import type { AuthLease } from "../../ports.ts";
import type { HostEpoch, SelectionIdentity, ServiceEpoch } from "../contract/identity.ts";
import type { ModelRecord } from "../../selection.ts";
import type { RunStepRequest } from "../contract/binding.ts";

export type LedgerStatus = "active" | "terminal" | "rejected" | "cancelled";

export type LedgerRecord = {
  snapshotDigest: string;
  selectionRevision: string;
  bindingId?: string;
  status: LedgerStatus;
};

export type RouteBindingRecord = {
  bindingId: string;
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  turnId: string;
  selection: SelectionIdentity;
  model: ModelRecord;
  fingerprint: string;
  lease: AuthLease;
  lastActivityMs: number;
};

export type TurnRecord = {
  serviceEpoch: string;
  bindingId?: string;
  poisoned: boolean;
  expired: boolean;
  lastActivityMs: number;
};

export type InferenceState = {
  serviceEpoch: string;
  ledgerMax: number;
  idleTtlMs: number;
  bindings: Map<string, RouteBindingRecord>;
  turns: Map<string, TurnRecord>;
  ledger: Map<string, LedgerRecord>;
  turnActive: Map<string, string>;
  cancelled: Set<string>;
};

export type InferenceMemoryOptions = {
  serviceEpoch?: string;
  ledgerMax?: number;
  idleTtlMs?: number;
};

export function emptyInferenceState(options: InferenceMemoryOptions = {}): InferenceState {
  return {
    serviceEpoch: options.serviceEpoch ?? "svc-1",
    ledgerMax: options.ledgerMax ?? LEDGER_ENTRIES_MAX,
    idleTtlMs: options.idleTtlMs ?? TURN_IDLE_MS,
    bindings: new Map(),
    turns: new Map(),
    ledger: new Map(),
    turnActive: new Map(),
    cancelled: new Set(),
  };
}

export function hostKey(epoch: HostEpoch): string {
  return canonicalJson(epoch);
}

export function turnKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId">): string {
  return canonicalJson({ host: hostKey(request.hostEpoch), agentId: request.agentId, turnId: request.turnId });
}

export function ledgerKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId" | "stepId">): string {
  return canonicalJson({
    host: hostKey(request.hostEpoch),
    agentId: request.agentId,
    turnId: request.turnId,
    stepId: request.stepId,
  });
}

export function bindingStoreKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId">): string {
  return turnKey(request);
}

export function makeBindingId(input: {
  hostEpoch: HostEpoch;
  agentId: string;
  turnId: string;
  serviceEpoch: string;
  selectionRevision: string;
}): string {
  return sha256Text(canonicalJson(input));
}

export function cloneState(state: InferenceState): InferenceState {
  return {
    ...state,
    bindings: new Map(state.bindings),
    turns: new Map(state.turns),
    ledger: new Map(state.ledger),
    turnActive: new Map(state.turnActive),
    cancelled: new Set(state.cancelled),
  };
}

export class InferenceMemory extends Context.Service<InferenceMemory, {
  readonly ref: SynchronizedRef.SynchronizedRef<InferenceState>;
  readonly cancels: Map<string, Deferred.Deferred<void>>;
  readonly turnScopes: Map<string, Scope.Closeable>;
}>()("grokbox/InferenceMemory") {}

export function inferenceMemoryLayer(options: InferenceMemoryOptions = {}) {
  return Layer.succeed(InferenceMemory, {
    ref: SynchronizedRef.makeUnsafe(emptyInferenceState(options)),
    cancels: new Map<string, Deferred.Deferred<void>>(),
    turnScopes: new Map<string, Scope.Closeable>(),
  });
}
