import { openAgentDuplication, openContinuityRecoveryStore } from "@grokbox/box-runtime/runtime";
import { ContinuityFailure, DuplicateReceiptUnstored, duplicatePlan, isContinuityHash, isContinuityUuid } from "@grokbox/runtime-kernel/continuity";
import type { CliDeps } from "../deps.ts";
import { GatewayClient } from "../gateway.ts";
import { nativeDuplicationGateway } from "../gateway-duplication.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";

function localOnly(deps: CliDeps) {
  if (!["auto", "local"].includes(deps.transport) || deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl) {
    throw new CliError("capability_unavailable", "Native duplication management is Box-local; no remote or daemon fallback is used.");
  }
}
function stopped(error: unknown, operationId?: string, scopeId?: string): never {
  if (error instanceof CliError) throw error;
  const reason = error instanceof ContinuityFailure ? error.code : "unavailable";
  throw new CliError(reason === "commit_unknown" ? "operation_outcome_unknown" : "capability_unavailable",
    "Native duplication did not complete; inspect the original operation before any further creation.", {
      hostReason: reason, next: operationId && scopeId
        ? `grokbox agents operations show ${operationId} --scope-id ${scopeId}`
        : "Run the read-only duplication preview first.",
      ...(operationId ? { context: { operationId, phase: "native-duplicate",
        ...(error instanceof DuplicateReceiptUnstored ? { object: { id: error.created.targetAgentId, kind: "agent" as const } } : {}) } } : {}),
    });
}

/** Default is a read-only plan. Confirmation binds the exact preview plus scope;
 * names/legacy IDs cannot select an unintended source. Subsequent rename is a
 * separate normal agents update operation, never a hidden post-create effect. */
export async function runAgentDuplicate(deps: CliDeps, agentId: string, raw: {
  timeoutMs?: string; json?: boolean; operationId?: string; expectPlan?: string; scopeId?: string; confirm?: boolean;
}): Promise<void> {
  if (!isContinuityUuid(agentId)) throw usage("An exact source Bot UUID is required.");
  if (raw.confirm && (!isContinuityUuid(raw.operationId) || !isContinuityHash(raw.expectPlan) || !isContinuityHash(raw.scopeId))) {
    throw usage("Duplication requires --operation-id, --expect-plan and --scope-id from the preview, plus --confirm.");
  }
  if (!raw.confirm && (raw.operationId !== undefined || raw.expectPlan !== undefined || raw.scopeId !== undefined)) throw usage("Run without execution options to preview; use agents operations show for a saved operation.");
  localOnly(deps);
  const io = ioFromOpts({ ...raw, timeoutMs: raw.timeoutMs ?? "60000" });
  const native = nativeDuplicationGateway(new GatewayClient({ ...deps, transport: "local" }), io.timeoutMs);
  try {
    if (!raw.confirm) {
      const plan = duplicatePlan(await native.inspectSource(agentId));
      writeSuccess(deps.stdout, { plan, executed: false,
        next: "Repeat with the returned plan revision/scope and one stable operation UUID. --confirm accepts native Routine copying and active-chat changes." });
      return;
    }
    const operation = openAgentDuplication({ durableRoot: deps.boxRuntimeRoot, scopeId: raw.scopeId!, native });
    const result = await operation.execute({ sourceAgentId: agentId, operationId: raw.operationId!, expectedPlanRevision: raw.expectPlan!, confirmed: true }, deps.signal);
    if (result.operation.state === "effect_unknown") {
      throw new CliError("operation_outcome_unknown", "The existing duplication may already have created a Bot. No new creation was attempted.", {
        context: { operationId: raw.operationId!, phase: "native-duplicate" },
        next: `grokbox agents operations show ${raw.operationId} --scope-id ${raw.scopeId}`,
      });
    }
    writeSuccess(deps.stdout, { ...result, fullClone: false, managedModelAssigned: false, relationshipsTransferred: false, sourceDeleted: false,
      next: result.result ? `grokbox agents show ${result.result.targetAgentId} --ownership` : "Preview the source again before requesting a different operation." });
  } catch (error) { stopped(error, raw.operationId, raw.scopeId); }
}

/** Offline operation inspection also serves future continuity consumers; this
 * entry has no native adapter and neither creates nor migrates the local DB. */
export async function runAgentOperation(deps: CliDeps, operationId: string, raw: { scopeId?: string; json?: boolean }): Promise<void> {
  if (!isContinuityUuid(operationId) || !isContinuityHash(raw.scopeId)) throw usage("The original operation UUID and --scope-id are required.");
  localOnly(deps);
  try {
    const store = openContinuityRecoveryStore({ durableRoot: deps.boxRuntimeRoot, scopeId: raw.scopeId });
    const operation = await store.operation(operationId);
    const record = operation.kind === "duplicate" ? await store.duplication(operationId) : { operation, result: null };
    writeSuccess(deps.stdout, { ...record, currentTargetChecked: false, nativeDispatched: false, fullClone: false,
      next: record.result ? `grokbox agents show ${record.result.targetAgentId} --ownership`
        : "Inspect the original operation; no native identity receipt is being asserted by this read." });
  } catch (error) { stopped(error, operationId, raw.scopeId); }
}
