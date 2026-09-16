import type { ContextSnapshot } from "./snapshot.ts";
import type { HostEpoch, SelectionIdentity, ServiceEpoch } from "./identity.ts";

export type BindingFailureCode =
  | "selection_mismatch"
  | "not_admitted"
  | "turn_busy"
  | "step_conflict"
  | "step_missing"
  | "step_invalid"
  | "capacity"
  | "ledger_unavailable"
  | "turn_expired"
  | "service_epoch_mismatch"
  | "binding_mismatch"
  | "binding_missing"
  | "auth_mismatch"
  | "cancelled";

export const BINDING_FAILURE_CODES: readonly BindingFailureCode[] = [
  "selection_mismatch",
  "not_admitted",
  "turn_busy",
  "step_conflict",
  "step_missing",
  "step_invalid",
  "capacity",
  "ledger_unavailable",
  "turn_expired",
  "service_epoch_mismatch",
  "binding_mismatch",
  "binding_missing",
  "auth_mismatch",
  "cancelled",
];

export class BindingFailure extends Error {
  readonly code: BindingFailureCode;

  constructor(code: BindingFailureCode) {
    super(code);
    this.name = "BindingFailure";
    this.code = code;
  }
}

export type RunStepRequest = {
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  turnId: string;
  stepId: string;
  selection: SelectionIdentity;
  snapshot: ContextSnapshot;
  bindingId?: string;
};

export type CancelStepRequest = {
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  turnId: string;
  stepId: string;
};

export type DuplicateStep = {
  kind: "duplicate";
  bindingId: string;
  snapshotDigest: string;
};
