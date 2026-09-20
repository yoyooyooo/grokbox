import { assertBoxLocal, observeOpsNotification, runExplicitOpsNotification, BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import type { CliDeps } from "../deps.ts";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { nativeExplicitReceiverReader } from "../gateway-receiver.ts";
import { ioFromOpts } from "../opts.ts";

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

/** One selected, existing work item. No arbitrary payload/URL/key, automatic
 * wake loop or implicit Routine enabling. Confirmation covers possible usage. */
export async function runOpsNotificationSend(deps: CliDeps, workId: string,
  raw: { confirm?: boolean; expectBindingRevision?: string; expectModelRevision?: string; timeoutMs?: string }) {
  assertBoxLocal(deps);
  if (deps.gatewayServerUrl || deps.daemonServerUrl || !monitorUuid(workId) || raw.confirm !== true
    || !/^[1-9][0-9]*$/.test(raw.expectBindingRevision ?? "") || !Number.isSafeInteger(Number(raw.expectBindingRevision))
    || !/^[a-f0-9]{64}$/.test(raw.expectModelRevision ?? ""))
    throw new CliError("invalid_usage", "An explicit Box-local notice needs its work ID, binding/model revisions, and confirmation.");
  const io = ioFromOpts(raw), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), io.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  try {
    const result = await runExplicitOpsNotification({ durableRoot: deps.boxRuntimeRoot, workId, confirmed: true,
      expectedBindingRevision: Number(raw.expectBindingRevision), expectedModelRevision: raw.expectModelRevision!, signal,
      readNative: nativeExplicitReceiverReader(deps, io.timeoutMs) });
    if (result.state !== "native-accepted" && result.state !== "already_attempted")
      throw new CliError(result.state === "unknown" ? "operation_outcome_unknown" : "capability_unavailable",
        `Notification send did not prove native acceptance (${result.state}). Read the same work ID; do not create or replay another attempt.`,
        { context: { operationId: workId, phase: "notification-send" } });
    writeSuccess(deps.stdout, result);
  } finally { clearTimeout(timer); }
}
