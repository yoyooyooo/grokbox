import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { detailRosterRow } from "../redaction.ts";
import { isRecord } from "../util.ts";
import { findRosterRow } from "./roster.ts";
import {
  applyAgentTitles, loadTitleModelIndex, readOwnershipStates, rosterTitleProjection, type TitleAction,
} from "../title-sync.ts";
import { parseAgentTitle } from "@grokbox/runtime-kernel/contract";

// Read projections and the separately owned title-marker presentation migration
// remain for D2-B. Generic product CRUD and deletion cleanup have one formal
// management owner; there is no dormant legacy creator or reaper in this module.
export async function runAgentsList(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string; includeHidden?: boolean; ownership?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const includeHidden = Boolean(raw.includeHidden);
  const projected = agents.filter(isRecord).map(rosterTitleProjection)
    .filter((row) => row.kind === "agent").filter((row) => includeHidden || !row.isHidden);
  let ownership: Awaited<ReturnType<typeof readOwnershipStates>> | undefined;
  if (raw.ownership) ownership = await readOwnershipStates(client, projected.map((row) => row.id), io.timeoutMs, discovery);
  const agentsOut = projected.map((row) => ({ ...row,
    ...(ownership ? { ownership: ownership.states.get(row.id) ?? "unconfirmed" } : {}),
  }));
  const data = { count: agentsOut.length, agents: agentsOut, ...(ownership ? { gatewayChanged: ownership.gatewayChanged } : {}) };
  if (io.table) {
    deps.stdout.write(formatTable(agentsOut.map((row) => ({
      id: row.id, name: row.name, title: row.title ?? "", harness: row.harness,
      owner: row.titleOwner ?? "", m: row.titleModel ?? "",
      ...(ownership ? { ownership: "ownership" in row ? String(row.ownership) : "unconfirmed" } : {}),
    }))));
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(discovery));
}

export async function runAgentsShow(
  deps: CliDeps, target: string, raw: { json?: boolean; timeoutMs?: string; ownership?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw), client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, ["agent"]), agent = rosterTitleProjection(row);
  let ownership: Awaited<ReturnType<typeof readOwnershipStates>> | undefined;
  if (raw.ownership) ownership = await readOwnershipStates(client, [agent.id], io.timeoutMs, discovery);
  writeSuccess(deps.stdout, { agent: {
    ...detailRosterRow(row), titleUser: agent.titleUser, titleShowing: agent.titleShowing,
    titleOwner: agent.titleOwner, titleModel: agent.titleModel, titleStale: agent.titleStale,
    ...(ownership ? { ownership: ownership.states.get(agent.id) ?? "unconfirmed" } : {}),
  } }, gatewayMeta(discovery));
}

export async function runAgentsTitle(
  deps: CliDeps, action: TitleAction, targets: string[],
  raw: { json?: boolean; table?: boolean; timeoutMs?: string; dryRun?: boolean; all?: boolean },
): Promise<void> {
  const names = targets.map((target) => target.trim()).filter((target) => target.length > 0), all = Boolean(raw.all);
  if (all && names.length > 0) throw usage("Do not combine --all with named agents.");
  if (action === "show" && !all && names.length === 0) throw usage("title show requires agents or --all.");
  const io = ioFromOpts(raw), client = new GatewayClient(deps);
  const listed = await client.listAgents(io.timeoutMs);
  const roster = listed.agents.filter(isRecord).filter((row) => row.isGroup !== true);
  let rows: Record<string, unknown>[];
  if (names.length > 0) rows = names.map((name) => findRosterRow(listed.agents, name, ["agent"]));
  else if (action === "sync") rows = roster.filter((row) => parseAgentTitle(row.title).showing);
  else rows = roster;
  const { tokens, assigned, efforts } = action === "hide"
    ? { tokens: new Map<string, string>() } : await loadTitleModelIndex(deps.boxRuntimeRoot, deps.env);
  const applied = await applyAgentTitles(client, io.timeoutMs, {
    action, rows, dryRun: Boolean(raw.dryRun), tokens, assigned, efforts,
  });
  const written = applied.rows.filter((row) => row.written).length;
  const skippedRows = applied.rows.filter((row) => row.skipped), skipped = skippedRows.length;
  const pending = applied.rows.filter((row) => row.changed && !row.written).length;
  const skips = skippedRows.map((row) => ({ agent: row.name || row.agentId, id: row.id, reason: row.skipped }));
  const data = { action, dryRun: Boolean(raw.dryRun), examined: applied.rows.length, written, skipped,
    ...(raw.dryRun ? { pending } : {}), ...(skips.length > 0 ? { skips } : {}),
  };
  if (io.table) {
    deps.stdout.write(formatTable(skips.length === 0 ? [{ action, examined: String(data.examined),
      written: String(written), skipped: String(skipped), ...(raw.dryRun ? { pending: String(pending) } : {}),
    }] : skips.map((row) => ({ agent: row.agent, id: row.id, reason: String(row.reason ?? "") }))));
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(listed.discovery));
}
