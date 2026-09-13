import { assertBoxLocal, openRuntimeStore, openMonitorStore, runMonitor, BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { runtimeOwnershipReader } from "../runtime-ownership.ts";

type Options = { agents?: string; intervalMs?: string; once?: boolean; after?: string; limit?: string;
  requestId?: string; expectedRevision?: string; untilMs?: string; confirm?: boolean };
function integer(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError("invalid_usage","monitor_requires_integer");
  return Number(value);
}
export async function runRuntimeMonitor(deps: CliDeps, action: "init"|"run"|"snapshot"|"events"|"incidents"|"ack"|"snooze", args: Array<string | undefined>, raw: Options): Promise<void> {
  try {
    assertBoxLocal({ sshHost: deps.sshHost, daemonServerUrl: deps.daemonServerUrl, transport: deps.transport, profileName: deps.profileName });
    if ((action === "init" || action === "run") && raw.confirm !== true) throw new CliError("invalid_usage","monitor_requires_confirm");
    const root = openRuntimeStore(deps.boxRuntimeRoot,deps.env).root;
    const store = openMonitorStore(root);
    if (action === "init") { writeSuccess(deps.stdout,await store.initialize()); return; }
    if (action === "snapshot") { writeSuccess(deps.stdout,await store.snapshot()); return; }
    if (action === "incidents") { writeSuccess(deps.stdout,{ ...await store.incidentPage(raw.after,raw.limit ? integer(raw.limit) : undefined), notificationMode: "local_only", admissionAuthority: false }); return; }
    if (action === "events") { writeSuccess(deps.stdout,await store.events(raw.after,raw.limit ? integer(raw.limit) : undefined)); return; }
    if (action === "ack" || action === "snooze") {
      writeSuccess(deps.stdout,await store.manage({ incidentId: args[0] ?? "", requestId: raw.requestId ?? "",
        expectedRevision: integer(raw.expectedRevision), action, nowMs: Date.now(),
        ...(action === "snooze" ? { untilMs: integer(raw.untilMs) } : {}) })); return;
    }
    if (!raw.agents) throw new CliError("invalid_usage","monitor_requires_agent_ids");
    const fallback = deps.signal ? undefined : new AbortController();
    const signal = deps.signal ?? fallback!.signal;
    const abort = () => fallback?.abort();
    if (fallback) { process.on("SIGINT",abort); process.on("SIGTERM",abort); }
    try {
      await runMonitor({ durableRoot: root, agentIds: raw.agents.split(","), read: runtimeOwnershipReader(deps), signal,
        intervalMs: raw.intervalMs ? integer(raw.intervalMs) : undefined, once: raw.once === true,
        publish: receipt => writeSuccess(deps.stdout,receipt) });
    } finally { if (fallback) { process.off("SIGINT",abort); process.off("SIGTERM",abort); } }
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (e instanceof BoxRuntimeError) throw new CliError(e.code,e.message);
    if (e instanceof Error && /^monitor_[a-z_]+$/.test(e.message)) throw new CliError("invalid_usage",e.message);
    throw new CliError("runtime_not_ready","monitor_unavailable");
  }
}
