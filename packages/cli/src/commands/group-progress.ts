import { assertBoxLocal, openRuntimeStore, observeRuntimeEvents } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { isRecord } from "../util.ts";
import { writeSuccess } from "../output.ts";

/** Local execution evidence only. The group object/roster is not an execution
 * authority and a buffered message is not a successful group publication. */
export async function runGroupProgress(deps: CliDeps, groupId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(groupId)) throw usage("Specify the exact group UUID.");
  assertBoxLocal({ sshHost: deps.sshHost, daemonServerUrl: deps.daemonServerUrl, transport: deps.transport, profileName: deps.profileName });
  const root = openRuntimeStore(deps.boxRuntimeRoot, deps.env).root;
  const observed = await observeRuntimeEvents({ durableRoot: root, runRoot: deps.env.GROKBOX_RUN_ROOT, source: "host", limit: 4096, selector: { groupId } });
  const events = (observed.events as unknown[]).filter(isRecord);
  const target = events.filter(e => e.groupId === groupId);
  const dispatches = new Map<string, Record<string, unknown>>();
  for (const e of target) {
    if (e.name !== "host_run_observation" || typeof e.dispatchId !== "string" || e.state === "member_returned") continue;
    const key = JSON.stringify([e.hostGenerationId, e.agentId, e.dispatchId]);
    const row: Record<string, unknown> = dispatches.get(key) ?? { hostGenerationId: e.hostGenerationId, agentId: e.agentId, dispatchId: e.dispatchId, groupDispatchId: e.groupDispatchId };
    if (e.state === "reply_buffered") { row.replyState = "buffered_not_published"; row.bufferedAt = e.at; }
    else { row.lastState = e.state; row.observedAt = e.at; }
    if (e.state === "queued") { row.queuedAt = e.at; row.blockingDispatchId = e.blockingDispatchId ?? null; }
    if (e.waitMs !== undefined) row.waitMs = e.waitMs;
    if (e.elapsedMs !== undefined) row.elapsedMs = e.elapsedMs;
    dispatches.set(key, row);
  }
  const rows = [...dispatches.values()].slice(-128);
  for (const row of rows) {
    row.relatedSteps = [...new Set(target.filter(e => e.dispatchId === row.dispatchId && e.agentId === row.agentId
      && e.hostGenerationId === row.hostGenerationId && typeof e.stepId === "string").map(e => e.stepId))];
    row.publication = "not_observed";
    row.freshness = "historical_snapshot_not_liveness";
  }
  writeSuccess(deps.stdout, { groupId, observedAt: new Date().toISOString(), members: rows,
    evidence: { state: observed.state, truncated: observed.truncated || dispatches.size > 128, window: observed.window,
      instrumentation: target.length ? "observed" : "not_observed_in_window", root: observed.root },
    limits: "No queue or reply is manufactured. started without a terminal is unfinished evidence, not proof the task is still running. Group publication must be checked separately in the group transcript." });
}
