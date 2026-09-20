import { assertBoxLocal, openRuntimeStore, openMonitorStore, runMonitor, runIncidentEvidenceCommand, observeRuntimeStorage, readStorageConfiguration, configureMonitorService, readMonitorServiceConfiguration, BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import type { IncidentEvidenceCommand } from "@grokbox/runtime-kernel/commands";
import type { EvidenceView } from "@grokbox/runtime-kernel/observation";
import { ConfigError } from "@grokbox/runtime-kernel/config";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { runtimeOwnershipReader } from "../runtime-ownership.ts";

type Options = { agents?: string; intervalMs?: string; once?: boolean; after?: string; limit?: string;
  runRoot?: string; operationId?: string; expectRevision?: string;
  confirm?: boolean;
  evidenceRevision?: string; revision?: string; durationMs?: string; view?: string; incident?: string; step?: string; tray?: string; agent?: string };
function integer(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError("invalid_usage","monitor_requires_integer");
  return Number(value);
}
export async function runRuntimeMonitor(deps: CliDeps, action: "init"|"install"|"run"|"snapshot"|"events"|"incidents"|"incident"|"capture"|"lease"|"storage-status", args: Array<string | undefined>, raw: Options): Promise<void> {
  try {
    assertBoxLocal({ sshHost: deps.sshHost, daemonServerUrl: deps.daemonServerUrl, transport: deps.transport, profileName: deps.profileName });
    if (deps.gatewayServerUrl) throw new CliError("runtime_local_only", "Monitor evidence requires a box-local Profile.");
    if ((action === "init" || action === "run") && raw.confirm !== true) throw new CliError("invalid_usage","monitor_requires_confirm");
    const root = openRuntimeStore(deps.boxRuntimeRoot,deps.env).root;
    if (action === "install") {
      if (!raw.runRoot || !raw.agents) throw new CliError("invalid_usage", "monitor_install_requires_explicit_sources");
      writeSuccess(deps.stdout, await configureMonitorService({ durableRoot: root, runRoot: raw.runRoot, agentIds: raw.agents.split(","),
        confirmed: raw.confirm === true, operationId: raw.operationId, expectedRevision: raw.expectRevision })); return;
    }
    const storage = action === "init" ? await readStorageConfiguration(root) : undefined;
    const store = openMonitorStore(root, storage?.monitor);
    if (["incident", "capture", "lease"].includes(action)) {
      if (raw.view && !["local-diagnostic", "bot-diagnostic", "public-summary"].includes(raw.view)) throw new CliError("invalid_usage", "monitor_invalid_evidence_view");
      let command: IncidentEvidenceCommand;
      if (action === "incident") command = { kind: "read", incidentId: args[0] ?? "", ...(raw.evidenceRevision ? { revision: integer(raw.evidenceRevision) } : {}), view: raw.view as EvidenceView | undefined };
      else if (action === "lease") command = { kind: "lease", incidentId: args[0] ?? "", revision: integer(raw.revision), durationMs: integer(raw.durationMs), confirmed: raw.confirm === true };
      else {
        if (raw.confirm !== true) throw new CliError("invalid_usage", "monitor_requires_confirm");
        if ([raw.incident, raw.step, raw.tray].filter(value => value !== undefined).length !== 1) throw new CliError("invalid_usage", "Select exactly one of --incident, --step with --agent, or --tray.");
        const incidentId = raw.incident ?? await store.resolveIncident({ agentId: raw.agent, stepId: raw.step, trayId: raw.tray });
        command = { kind: "capture", incidentId, confirmed: true };
      }
      const result = await runIncidentEvidenceCommand({ durableRoot: root, command, signal: deps.signal });
      writeSuccess(deps.stdout, result); return;
    }
    if (action === "init") { writeSuccess(deps.stdout,await store.initialize()); return; }
    if (action === "snapshot") { writeSuccess(deps.stdout,await store.snapshot()); return; }
    if (action === "storage-status") {
      const configured = await readMonitorServiceConfiguration(root).catch(() => null);
      writeSuccess(deps.stdout, await observeRuntimeStorage({ durableRoot: root, runRoot: deps.env.GROKBOX_RUN_ROOT ?? configured?.runRoot })); return;
    }
    if (action === "incidents") { writeSuccess(deps.stdout,{ ...await store.incidentPage(raw.after,raw.limit ? integer(raw.limit) : undefined), notificationMode: "local_only", admissionAuthority: false }); return; }
    if (action === "events") { writeSuccess(deps.stdout,await store.events(raw.after,raw.limit ? integer(raw.limit) : undefined)); return; }
    if (!raw.agents) throw new CliError("invalid_usage","monitor_requires_agent_ids");
    const fallback = deps.signal ? undefined : new AbortController();
    const signal = deps.signal ?? fallback!.signal;
    const abort = () => fallback?.abort();
    if (fallback) { process.on("SIGINT",abort); process.on("SIGTERM",abort); }
    try {
      await runMonitor({ durableRoot: root, runRoot: deps.env.GROKBOX_RUN_ROOT, agentIds: raw.agents.split(","), read: runtimeOwnershipReader(deps), signal,
        intervalMs: raw.intervalMs ? integer(raw.intervalMs) : undefined, once: raw.once === true, includeControlJournal: true,
        publish: receipt => writeSuccess(deps.stdout,receipt) });
    } finally { if (fallback) { process.off("SIGINT",abort); process.off("SIGTERM",abort); } }
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (e instanceof ConfigError) throw new CliError(e.code,e.message);
    if (e instanceof BoxRuntimeError) throw new CliError(e.code,e.message);
    if (e instanceof Error && /^monitor_[a-z_]+$/.test(e.message)) throw new CliError("invalid_usage",e.message);
    throw new CliError("runtime_not_ready","monitor_unavailable");
  }
}
