import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { flattenRows, formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { resolveSecretRef } from "../config/secret.ts";
import { queryCursorWebQuota } from "../quota.ts";

export async function runQuota(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (deps.quotaSource !== "cursor-web" || !deps.quotaAccessTokenRef) {
    throw new CliError(
      "quota_unavailable",
      "The selected Profile does not declare an explicit supported quota source.",
    );
  }
  const token = await resolveSecretRef(deps, deps.quotaAccessTokenRef);
  const snapshot = await queryCursorWebQuota(deps, token, io.timeoutMs);
  if (io.table) {
    deps.stdout.write(formatTable(flattenRows(snapshot as unknown as Record<string, unknown>)));
    return;
  }
  writeSuccess(deps.stdout, snapshot);
}
