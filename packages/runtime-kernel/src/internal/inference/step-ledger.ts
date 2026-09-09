import { contextSnapshotBody } from "../contract/snapshot.ts";
import { computeSnapshotDigest } from "../../hash.ts";
import { BindingFailure, type RunStepRequest } from "../contract/binding.ts";
import {
  cloneState,
  ledgerKey,
  turnKey,
  type InferenceState,
  type LedgerRecord,
} from "./route-binding.ts";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function canonicalSnapshotDigest(snapshot: RunStepRequest["snapshot"]): string {
  return computeSnapshotDigest(contextSnapshotBody(snapshot));
}

export function assertStepIdentity(request: RunStepRequest): BindingFailure | undefined {
  if (!request.agentId || !ID.test(request.agentId) || !request.turnId || !ID.test(request.turnId)) {
    return new BindingFailure("step_invalid");
  }
  if (!request.stepId) return new BindingFailure("step_missing");
  if (!ID.test(request.stepId)) return new BindingFailure("step_invalid");
  if (!request.selection?.agentId || !request.selection.modelId || !request.selection.selectionRevision) {
    return new BindingFailure("step_invalid");
  }
  if (request.selection.agentId !== request.agentId) return new BindingFailure("step_invalid");
  if (canonicalSnapshotDigest(request.snapshot) !== request.snapshot.snapshotDigest) {
    return new BindingFailure("step_invalid");
  }
  return undefined;
}

export type OccupyResult =
  | { ok: true; kind: "duplicate"; bindingId: string; snapshotDigest: string; state: InferenceState }
  | { ok: true; kind: "proceed"; state: InferenceState }
  | { ok: false; error: BindingFailure };

function sameInput(entry: LedgerRecord, digest: string, revision: string): boolean {
  return entry.snapshotDigest === digest && entry.selectionRevision === revision;
}

export function occupy(state: InferenceState, request: RunStepRequest, now: number): OccupyResult {
  const invalid = assertStepIdentity(request);
  if (invalid) return { ok: false, error: invalid };
  if (request.serviceEpoch.incarnationId !== state.serviceEpoch) {
    return { ok: false, error: new BindingFailure("service_epoch_mismatch") };
  }

  const digest = canonicalSnapshotDigest(request.snapshot);
  const next = cloneState(state);
  const tKey = turnKey(request);
  const lKey = ledgerKey(request);
  const turn = next.turns.get(tKey);

  if (turn?.poisoned) return { ok: false, error: new BindingFailure("cancelled") };
  if (turn?.expired || (turn && now - turn.lastActivityMs > next.idleTtlMs)) {
    if (turn) {
      turn.expired = true;
      next.turns.set(tKey, turn);
    }
    return { ok: false, error: new BindingFailure("turn_expired") };
  }
  if (turn && turn.serviceEpoch !== request.serviceEpoch.incarnationId) {
    return { ok: false, error: new BindingFailure("service_epoch_mismatch") };
  }

  const existing = next.ledger.get(lKey);
  if (existing) {
    if (!sameInput(existing, digest, request.selection.selectionRevision)) {
      return { ok: false, error: new BindingFailure("step_conflict") };
    }
    return {
      ok: true,
      kind: "duplicate",
      bindingId: existing.bindingId ?? "",
      snapshotDigest: digest,
      state,
    };
  }

  const activeStep = next.turnActive.get(tKey);
  if (activeStep && activeStep !== request.stepId) {
    return { ok: false, error: new BindingFailure("turn_busy") };
  }

  if (next.ledger.size >= next.ledgerMax) {
    return { ok: false, error: new BindingFailure("capacity") };
  }

  const record: LedgerRecord = {
    snapshotDigest: digest,
    selectionRevision: request.selection.selectionRevision,
    bindingId: turn?.bindingId,
    status: "active",
  };
  next.ledger.set(lKey, record);
  next.turnActive.set(tKey, request.stepId);
  next.turns.set(tKey, {
    serviceEpoch: request.serviceEpoch.incarnationId,
    bindingId: turn?.bindingId,
    poisoned: false,
    expired: false,
    lastActivityMs: now,
  });
  return { ok: true, kind: "proceed", state: next };
}

export function releaseOccupancy(state: InferenceState, request: RunStepRequest, status: LedgerRecord["status"]): InferenceState {
  const next = cloneState(state);
  const tKey = turnKey(request);
  const lKey = ledgerKey(request);
  const entry = next.ledger.get(lKey);
  if (entry && entry.status === "active") {
    next.ledger.set(lKey, { ...entry, status });
  }
  if (next.turnActive.get(tKey) === request.stepId) next.turnActive.delete(tKey);
  return next;
}

export type CancelApply =
  | { ok: true; interrupt: boolean; state: InferenceState }
  | { ok: false; error: BindingFailure };

export function applyCancel(
  state: InferenceState,
  request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId" | "stepId" | "serviceEpoch">,
): CancelApply {
  if (request.serviceEpoch.incarnationId !== state.serviceEpoch) {
    return { ok: false, error: new BindingFailure("service_epoch_mismatch") };
  }
  const next = cloneState(state);
  const lKey = ledgerKey(request);
  const tKey = turnKey(request);
  const entry = next.ledger.get(lKey);
  if (entry) {
    if (entry.status !== "active") {
      return { ok: true, interrupt: false, state };
    }
    next.ledger.set(lKey, { ...entry, status: "cancelled" });
    if (next.turnActive.get(tKey) === request.stepId) next.turnActive.delete(tKey);
    const turn = next.turns.get(tKey);
    if (turn && !turn.bindingId) next.turns.set(tKey, { ...turn, poisoned: true });
    return { ok: true, interrupt: true, state: next };
  }
  if (next.ledger.size >= next.ledgerMax) {
    return { ok: false, error: new BindingFailure("capacity") };
  }
  next.ledger.set(lKey, {
    snapshotDigest: "",
    selectionRevision: "",
    status: "cancelled",
  });
  return { ok: true, interrupt: false, state: next };
}
