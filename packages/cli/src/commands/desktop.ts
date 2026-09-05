import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { GatewayClient } from "../gateway.ts";
import { isRecord } from "../util.ts";

const DESKTOP_READ = "host.desktop.read";
const DESKTOP_REAP = "host.desktop.reap";

type DesktopOptions = {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string;
  yes?: boolean;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CliError("daemon_unreachable", `Daemon returned an invalid ${label} result.`);
  return value;
}

export async function runDesktopStatus(deps: CliDeps, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await new GatewayClient(deps).daemonCapability(DESKTOP_READ, io.timeoutMs);
  const data = record((await client.call("desktopStatus", {})).result, "desktop status");
  if (io.table) {
    const ids = (value: unknown): string =>
      Array.isArray(value) ? value.map((id) => String(id)).join(",") : "";
    deps.stdout.write(formatTable([{
      pruneEnabled: String(data.pruneEnabled ?? false),
      minIdleMs: String(data.minIdleMs ?? ""),
      floorAgentIds: ids(data.floorAgentIds),
      keepAgentIds: ids(data.keepAgentIds),
    }]));
    const displays = Array.isArray(data.displays) ? data.displays : [];
    deps.stdout.write(formatTable(displays.map((row) => {
      const item = isRecord(row) ? row : {};
      return {
        display: String(item.display ?? ""),
        agentId: String(item.agentId ?? ""),
        lit: String(item.lit ?? ""),
        idle: String(item.idle ?? ""),
        protected: String(item.protected ?? ""),
        busyReason: item.busyReason == null ? "" : String(item.busyReason),
      };
    })));
    return;
  }
  writeSuccess(deps.stdout, data);
}

export async function runDesktopKeepAdd(deps: CliDeps, agent: string, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("desktop keep add does not support --table.");
  const client = await new GatewayClient(deps).daemonCapability(DESKTOP_READ, io.timeoutMs);
  const data = record((await client.call("desktopKeepAdd", { agentId: agent })).result, "desktop keep add");
  writeSuccess(deps.stdout, data);
}

export async function runDesktopKeepRemove(deps: CliDeps, agent: string, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("desktop keep remove does not support --table.");
  if (!raw.yes) throw usage("desktop keep remove requires --yes.");
  const client = await new GatewayClient(deps).daemonCapability(DESKTOP_READ, io.timeoutMs);
  const data = record(
    (await client.call("desktopKeepRemove", { agentId: agent, yes: true })).result,
    "desktop keep remove",
  );
  writeSuccess(deps.stdout, data);
}

export async function runDesktopPruneRun(deps: CliDeps, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const yes = Boolean(raw.yes);
  const capability = yes ? DESKTOP_REAP : DESKTOP_READ;
  const client = await new GatewayClient(deps).daemonCapability(capability, io.timeoutMs);
  const data = record(
    (await client.call(yes ? "desktopPrune" : "desktopPrunePlan", yes ? { yes: true } : {})).result,
    "desktop prune",
  );
  if (io.table) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    deps.stdout.write(formatTable(rows.map((row) => {
      const item = isRecord(row) ? row : {};
      return {
        display: String(item.display ?? ""),
        agentId: String(item.agentId ?? ""),
        outcome: String(item.outcome ?? ""),
        busyReason: item.busyReason == null ? "" : String(item.busyReason),
      };
    })));
    return;
  }
  writeSuccess(deps.stdout, data);
}

export async function runDesktopPruneEnable(deps: CliDeps, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("desktop prune enable does not support --table.");
  const client = await new GatewayClient(deps).daemonCapability(DESKTOP_REAP, io.timeoutMs);
  const data = record((await client.call("desktopPruneEnable", {})).result, "desktop prune enable");
  writeSuccess(deps.stdout, data);
}

export async function runDesktopPruneDisable(deps: CliDeps, raw: DesktopOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("desktop prune disable does not support --table.");
  const client = await new GatewayClient(deps).daemonCapability(DESKTOP_READ, io.timeoutMs);
  const data = record((await client.call("desktopPruneDisable", {})).result, "desktop prune disable");
  writeSuccess(deps.stdout, data);
}
