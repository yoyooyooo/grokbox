import { exportLocalAgent } from "../agent-export.ts";
import { DEFAULT_AGENT_DATA_ROOT } from "../registry.ts";
import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts, rejectTable } from "../opts.ts";

export async function runExportAgent(
  deps: CliDeps,
  target: string,
  raw: {
    json?: boolean;
    table?: boolean;
    out?: string;
    agentData?: string;
    includeRelatedWorkflows?: boolean;
  },
): Promise<void> {
  const io = ioFromOpts(raw);
  rejectTable(io.table, false);
  if (target.trim().length === 0) throw usage("Agent is required.");
  const out = raw.out?.trim() ?? "";
  if (out.length === 0) throw usage("--out is required.");
  const summary = await exportLocalAgent({
    target,
    out,
    agentDataRoot: raw.agentData?.trim() || deps.agentDataRoot || DEFAULT_AGENT_DATA_ROOT,
    cwd: process.cwd(),
    nowMs: deps.now(),
    includeRelatedWorkflows: Boolean(raw.includeRelatedWorkflows),
  });
  writeSuccess(deps.stdout, summary);
}
