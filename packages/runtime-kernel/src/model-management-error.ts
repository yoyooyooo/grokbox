export type ModelManagementCode = "invalid_input" | "not_found" | "revision_conflict" | "idempotency_conflict" | "operation_unknown"
  | "model_in_use" | "model_default_in_use" | "model_default_missing" | "model_source_read_only" | "store_full" | "unavailable";
export class ModelManagementError extends Error {
  readonly _tag = "ModelManagementError";
  constructor(readonly code: ModelManagementCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ModelManagementError";
  }
}
