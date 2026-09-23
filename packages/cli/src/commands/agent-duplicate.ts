import { openContinuityRecoveryStore } from "@grokbox/box-runtime/runtime";
import { ContinuityFailure, isContinuityHash, isContinuityUuid } from "@grokbox/runtime-kernel/continuity";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";

/** Original offline operation inspection preserves unknown evidence. There is
 * no native adapter here: creation is owned by formal product management. */
export async function runAgentOperation(deps: CliDeps, operationId: string, raw: { scopeId?: string; json?: boolean }): Promise<void> {
  if (!isContinuityUuid(operationId) || !isContinuityHash(raw.scopeId)) throw usage("The original operation UUID and --scope-id are required.");
  if (!["auto", "local"].includes(deps.transport) || deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl) {
    throw new CliError("capability_unavailable", "Historical CONT inspection is Box-local and has no remote or daemon fallback.");
  }
  try {
    const store = openContinuityRecoveryStore({ durableRoot: deps.boxRuntimeRoot, scopeId: raw.scopeId });
    const operation = await store.operation(operationId);
    const record = operation.kind === "duplicate" ? await store.duplication(operationId) : { operation, result: null };
    writeSuccess(deps.stdout, { ...record, currentTargetChecked: false, nativeDispatched: false, fullClone: false,
      next: record.result ? `grokbox bot ownership get ${record.result.targetAgentId}`
        : "Inspect the original operation; no native identity receipt is being asserted by this read." });
  } catch (error) {
    if (error instanceof CliError) throw error;
    const reason = error instanceof ContinuityFailure ? error.code : "unavailable";
    throw new CliError(reason === "commit_unknown" ? "operation_outcome_unknown" : "capability_unavailable",
      "The original CONT operation could not be inspected; no native effect or new safety store was created.", {
        hostReason: reason, context: { operationId, phase: "native-duplicate" },
      });
  }
}
