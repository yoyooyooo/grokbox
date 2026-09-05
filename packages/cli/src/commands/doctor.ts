import type { CliDeps } from "../deps.ts";
import { diagnose } from "../diagnostics.ts";
import { flattenRows, formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";

export async function runDoctor(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const report = await diagnose(deps, io.timeoutMs);
  if (io.table) {
    deps.stdout.write(formatTable(flattenRows(report as unknown as Record<string, unknown>)));
    return;
  }
  const gateway = report.discovery
    ? { pid: report.discovery.pid, startedAt: report.discovery.startedAt }
    : undefined;
  writeSuccess(deps.stdout, report, gateway);
}
