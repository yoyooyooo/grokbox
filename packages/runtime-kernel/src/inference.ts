export { contextStatus, type ContextStatusQuery } from "./internal/inference/context-status.ts";
export { captureContextSelection } from "./internal/inference/context-selection.ts";
export { runStep, cancelStep, type AdmittedStep, type LiveStep } from "./internal/inference/step-program.ts";
export { makeContextMaintenanceRunner, validateContextReplacement, type ContextMaintenanceExecution } from "./internal/inference/context-maintenance.ts";
export { InferenceMemory, inferenceMemoryLayer, inferenceCapacity, coolInactiveTurns, type InferenceMemoryOptions } from "./internal/inference/route-binding.ts";
export { memoryExecutionHistory, type ExecutionHistory, type ExecutionHistoryHealth, type ColdTurn } from "./internal/inference/execution-history.ts";
export type { LedgerRecord } from "./internal/inference/route-binding.ts";
export { admitOverflowRecovery, runOverflowRecovery } from "./internal/inference/overflow-recovery.ts";
export type { DuplicateStep, RunStepRequest, CancelStepRequest } from "./internal/contract/binding.ts";
