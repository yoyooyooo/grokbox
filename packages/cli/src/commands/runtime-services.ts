import { homedir } from "node:os";
import { runRuntimeServiceCommand, RuntimeServiceError, type RuntimeServiceRequest } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";

export async function runRuntimeServicesCli(deps: CliDeps, action: RuntimeServiceRequest["action"], raw: {
  runRoot?: string; release?: string; node?: string; confirm?: boolean; expectPlan?: string; start?: boolean;
}) {
  const runRoot = raw.runRoot ?? deps.env.GROKBOX_RUN_ROOT;
  if (!runRoot) throw usage("Provide the exact --run-root (or GROKBOX_RUN_ROOT); service paths are never inferred from HOME.");
  if (raw.start && action !== "install") throw usage("--start is only valid with services install.");
  try {
    const result = await runRuntimeServiceCommand({ action, durableRoot: deps.boxRuntimeRoot, runRoot, home: homedir(),
      releaseRoot: raw.release, nodeExecutable: raw.node, confirmed: raw.confirm === true,
      expectedPlan: raw.expectPlan, start: raw.start === true, signal: deps.signal });
    writeSuccess(deps.stdout, result);
  } catch (e) {
    const reason = e instanceof RuntimeServiceError ? e.reason : "unavailable";
    throw new CliError(reason === "installation_outcome_unknown" ? "operation_outcome_unknown"
      : ["plan_conflict", "invalid_path", "invalid_action"].includes(reason) ? "invalid_usage" : "capability_unavailable",
      `Runtime service registration stopped: ${reason}.`);
  }
}
