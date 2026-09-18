import { assertBoxLocal, runOpsPairing, observeOpsTargets, revokeOpsTarget } from "@grokbox/box-runtime/runtime";
import { OPS_PAIRING_POLICY, OpsPairingError, validatePairingCommand } from "@grokbox/runtime-kernel/observation";
import { NATIVE_ROUTINE_MAX_BYTES, projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { GatewayClient, type Discovery } from "../gateway.ts";
import { CliError } from "../errors.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";
import type { CliDeps } from "../deps.ts";

export async function runOpsTargetsCli(deps: CliDeps, action: "list" | "show" | "bind" | "disable" | "unbind", alias: string | undefined,
  raw: { json?: boolean; timeoutMs?: string; routineId?: string; expectRevision?: string; operationId?: string;
    expectBindingRevision?: string; preview?: boolean; confirm?: boolean }) {
  assertBoxLocal(deps);
  if (deps.gatewayServerUrl) throw new CliError("invalid_usage", "Target pairing requires this Box's native Gateway, not an explicit URL.");
  const durableRoot = deps.boxRuntimeRoot, io = ioFromOpts(raw);
  try {
    if (action === "list" || action === "show") {
      if (action === "show" && !alias) throw new OpsPairingError("invalid_input");
      writeSuccess(deps.stdout, await observeOpsTargets({ durableRoot, ...(alias ? { alias } : {}) })); return;
    }
    const expected = raw.expectBindingRevision === undefined ? 0 : /^\d+$/.test(raw.expectBindingRevision) ? Number(raw.expectBindingRevision) : NaN;
    if (!Number.isSafeInteger(expected) || expected < 0) throw new OpsPairingError("invalid_input");
    if (action === "disable" || action === "unbind") {
      writeSuccess(deps.stdout, await revokeOpsTarget({ durableRoot, alias: alias ?? "", expectedRevision: expected, action, confirmed: raw.confirm === true })); return;
    }
    if (raw.preview && raw.confirm) throw new OpsPairingError("invalid_input");
    const command = validatePairingCommand({ action: raw.preview ? "preview" : "bind", alias: alias ?? "", routineId: raw.routineId ?? "",
      expectedRevision: raw.expectRevision ?? "", operationId: raw.operationId ?? "", ...(raw.confirm ? { confirmed: true } : {}) });
    const client = new GatewayClient({ ...deps, transport: "local" });
    const deadline = performance.now() + io.timeoutMs;
    const timeout = () => { const left = Math.min(10000, Math.floor(deadline - performance.now())); if (left < 1 || deps.signal?.aborted) throw new OpsPairingError("credential_unavailable"); return left; };
    const generation = (d: Discovery) => sha256Text(canonicalJson([d.baseUrl, d.pid, d.startedAt]));
    const result = await runOpsPairing({ durableRoot, command, expectedBindingRevision: expected, signal: deps.signal, native: {
      list: async agentId => {
        const read = await client.rpc("getAgentAutomations", { id: agentId }, { timeoutMs: timeout(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES });
        return { catalog: projectNativeRoutines(agentId, read.result), generation: generation(read.discovery) };
      },
      credential: async (agentId, routineId) => {
        // This native operation may mint a credential. It is never exposed as a
        // generic CLI read; only the durable confirmed pairing path calls it.
        const read = await client.rpc("getAutomationWebhookCredential", { id: agentId, automationId: routineId },
          { timeoutMs: timeout(), maxResponseBytes: OPS_PAIRING_POLICY.maxCredentialResponseBytes, write: true, unknownOutcomeCode: "operation_outcome_unknown" });
        return { value: read.result, generation: generation(read.discovery) };
      },
    } });
    writeSuccess(deps.stdout, result);
  } catch (e) {
    const reason = e instanceof OpsPairingError ? e.reason : "store_unavailable";
    throw new CliError(reason === "outcome_unknown" ? "operation_outcome_unknown" : ["invalid_input", "confirmation_required", "operation_conflict"].includes(reason) ? "invalid_usage" : "capability_unavailable",
      `Target pairing stopped: ${reason}.`, { next: "Inspect ops targets show for this alias; no automatic credential retry, Routine enable or delivery occurred." });
  }
}
