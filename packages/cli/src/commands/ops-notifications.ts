import { assertBoxLocal, observeOpsNotification, BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import type { CliDeps } from "../deps.ts";

/** Local read-only inspection. No driver, binding, credential, send, reservation,
 * profile initialization, database initialization or automatic retry. */
export async function runOpsNotifications(deps: CliDeps, workId?: string) {
  try {
    assertBoxLocal(deps);
    writeSuccess(deps.stdout, await observeOpsNotification({ durableRoot: deps.boxRuntimeRoot, ...(workId ? { workId } : {}) }));
  } catch (error) {
    if (error instanceof BoxRuntimeError) throw new CliError(error.code, error.message);
    throw new CliError("capability_unavailable", "Local notification evidence is unavailable; no store was created.");
  }
}
