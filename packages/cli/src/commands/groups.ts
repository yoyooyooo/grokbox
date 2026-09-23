import type { CliDeps } from "../deps.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { compactRosterRow, detailRosterRow } from "../redaction.ts";
import { isRecord } from "../util.ts";
import { findRosterRow } from "./roster.ts";

// Remaining read-only projections migrate with D2-B presentation. All Group
// mutations are management-owned; no old creator/member writer is retained here.
export async function runGroupsList(
  deps: CliDeps, raw: { json?: boolean; table?: boolean; timeoutMs?: string; includeHidden?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw), client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const projected = agents.filter(isRecord).map(compactRosterRow).filter((row) => row.kind === "group")
    .filter((row) => Boolean(raw.includeHidden) || !row.isHidden);
  const data = { count: projected.length, groups: projected };
  if (io.table) {
    deps.stdout.write(formatTable(projected.map((row) => ({
      id: row.id, name: row.name, running: String(row.isRunning), unread: String(row.hasUnread),
    }))));
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(discovery));
}
export async function runGroupsShow(
  deps: CliDeps, target: string, raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw), client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, ["group"]);
  writeSuccess(deps.stdout, { group: detailRosterRow(row) }, gatewayMeta(discovery));
}
function memberProjection(agents: unknown[], target: string) {
  const group = detailRosterRow(findRosterRow(agents, target, ["group"])), rows = agents.filter(isRecord);
  const members = group.memberIds.flatMap((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    return row ? [compactRosterRow(row)] : [];
  });
  const found = new Set(members.map((member) => member.id));
  return { group: { id: group.id, name: group.name }, count: members.length, members,
    missingMemberIds: group.memberIds.filter((id) => !found.has(id)),
  };
}
export async function runGroupMembersList(
  deps: CliDeps, target: string, raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw), client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  writeSuccess(deps.stdout, memberProjection(agents, target), gatewayMeta(discovery));
}
