import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { compactRosterRow, detailRosterRow } from "../redaction.ts";
import { asString, isRecord } from "../util.ts";
import {
  GROUP_MAX_MEMBERS,
  applyRosterSettings,
  assertAnyAttribute,
  confirmDeletion,
  createNonce,
  createProfile,
  hasProfilePatch,
  mergedProfile,
  resolveMemberIds,
  validateRosterSettings,
  type RosterAttributes,
} from "./management.ts";
import { findRosterRow } from "./roster.ts";

export async function runGroupsList(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string; includeHidden?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const includeHidden = Boolean(raw.includeHidden);
  const projected = agents
    .filter(isRecord)
    .map(compactRosterRow)
    .filter((row) => row.kind === "group")
    .filter((row) => includeHidden || !row.isHidden);
  const data = { count: projected.length, groups: projected };
  if (io.table) {
    deps.stdout.write(
      formatTable(
        projected.map((row) => ({
          id: row.id,
          name: row.name,
          running: String(row.isRunning),
          unread: String(row.hasUnread),
        })),
      ),
    );
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(discovery));
}

export async function runGroupsShow(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, ["group"]);
  writeSuccess(deps.stdout, { group: detailRosterRow(row) }, gatewayMeta(discovery));
}

function memberProjection(agents: unknown[], target: string) {
  const group = detailRosterRow(findRosterRow(agents, target, ["group"]));
  const rows = agents.filter(isRecord);
  const members = group.memberIds.flatMap((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    return row ? [compactRosterRow(row)] : [];
  });
  const found = new Set(members.map((member) => member.id));
  return {
    group: { id: group.id, name: group.name },
    count: members.length,
    members,
    missingMemberIds: group.memberIds.filter((id) => !found.has(id)),
  };
}

export async function runGroupMembersList(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  writeSuccess(deps.stdout, memberProjection(agents, target), gatewayMeta(discovery));
}

export async function runGroupsCreate(
  deps: CliDeps,
  raw: RosterAttributes & { json?: boolean; timeoutMs?: string; member?: string[] },
): Promise<void> {
  const io = ioFromOpts(raw);
  validateRosterSettings(raw);
  const client = new GatewayClient(deps);
  const operationId = createNonce(undefined, deps);
  const before = await client.listAgents(io.timeoutMs);
  const memberAgentIds = resolveMemberIds(before.agents, raw.member ?? []);
  const profile = createProfile(raw);
  const created = await client.createGroup(
    { name: profile.name, description: profile.description, memberAgentIds },
    io.timeoutMs,
    operationId,
  );
  if (!isRecord(created.result) || !isRecord(created.result.agent)) {
    throw new CliError("gateway_internal", "Gateway createGroup response has the wrong shape.");
  }
  const id = asString(created.result.agent.id);
  if (id.length === 0) throw new CliError("gateway_internal", "Gateway created group lacks an ID.");
  try {
    if (raw.title !== undefined || raw.avatarShape !== undefined || raw.avatarColor !== undefined) {
      await client.updateAgent({ id, profile: mergedProfile(created.result.agent, raw) }, io.timeoutMs, operationId);
    }
    await applyRosterSettings(client, id, raw, io.timeoutMs, operationId);
    const current = await client.listAgents(io.timeoutMs);
    const group = detailRosterRow(findRosterRow(current.agents, id, ["group"]));
    writeSuccess(deps.stdout, { group }, gatewayMeta(current.discovery));
  } catch (error) {
    throw new CliError("operation_outcome_unknown", "Group was created but its final settings or projection could not be reconciled.", {
      context: {
        operationId,
        object: { id, kind: "group" },
        phase: "post-create",
        ...(error instanceof CliError ? { causeCode: error.code } : {}),
      },
    });
  }
}

export async function runGroupsUpdate(
  deps: CliDeps,
  target: string,
  raw: RosterAttributes & { json?: boolean; timeoutMs?: string },
): Promise<void> {
  assertAnyAttribute(raw);
  validateRosterSettings(raw);
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const operationId = createNonce(undefined, deps);
  const before = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(before.agents, target, ["group"]);
  const id = asString(row.id);
  if (hasProfilePatch(raw)) {
    const updated = await client.updateAgent({ id, profile: mergedProfile(row, raw) }, io.timeoutMs, operationId);
    if (updated.result === null) throw new CliError("target_not_found", "Group disappeared before update.");
  }
  await applyRosterSettings(client, id, raw, io.timeoutMs, operationId);
  const current = await client.listAgents(io.timeoutMs);
  const group = detailRosterRow(findRosterRow(current.agents, id, ["group"]));
  writeSuccess(deps.stdout, { group }, gatewayMeta(current.discovery));
}

export async function runGroupsDelete(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; yes?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const before = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(before.agents, target, ["group"]);
  await confirmDeletion(deps, raw.yes, "group", row);
  const deleted = await client.deleteAgent(asString(row.id), io.timeoutMs, createNonce(undefined, deps));
  writeSuccess(
    deps.stdout,
    { deleted: { id: asString(row.id), name: asString(row.name), kind: "group" } },
    gatewayMeta(deleted.discovery),
  );
}

async function setMembers(
  deps: CliDeps,
  client: GatewayClient,
  groupId: string,
  memberAgentIds: string[],
  timeoutMs: number,
  operationId: string,
): Promise<void> {
  const updated = await client.setGroupMembers({ id: groupId, memberAgentIds }, timeoutMs, operationId);
  if (updated.result === null) throw new CliError("target_not_found", "Group disappeared before membership update.");
  const current = await client.listAgents(timeoutMs);
  writeSuccess(deps.stdout, memberProjection(current.agents, groupId), gatewayMeta(current.discovery));
}

export async function runGroupMembersAdd(
  deps: CliDeps,
  groupTarget: string,
  agentTarget: string,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const before = await client.listAgents(io.timeoutMs);
  const group = detailRosterRow(findRosterRow(before.agents, groupTarget, ["group"]));
  const agent = findRosterRow(before.agents, agentTarget, ["agent"]);
  const agentId = asString(agent.id);
  if (group.memberIds.includes(agentId)) throw usage("Agent is already a member of this group.");
  if (group.memberIds.length >= GROUP_MAX_MEMBERS) {
    throw usage(`A group can contain at most ${GROUP_MAX_MEMBERS} members.`);
  }
  await setMembers(deps, client, group.id, [...group.memberIds, agentId], io.timeoutMs, createNonce(undefined, deps));
}

export async function runGroupMembersRemove(
  deps: CliDeps,
  groupTarget: string,
  agentTarget: string,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const before = await client.listAgents(io.timeoutMs);
  const group = detailRosterRow(findRosterRow(before.agents, groupTarget, ["group"]));
  const agent = findRosterRow(before.agents, agentTarget, ["agent"]);
  const agentId = asString(agent.id);
  if (!group.memberIds.includes(agentId)) throw usage("Agent is not a member of this group.");
  const next = group.memberIds.filter((id) => id !== agentId);
  if (next.length === 0) throw usage("A group must retain at least one member.");
  await setMembers(deps, client, group.id, next, io.timeoutMs, createNonce(undefined, deps));
}

export async function runGroupMembersSet(
  deps: CliDeps,
  groupTarget: string,
  raw: { json?: boolean; timeoutMs?: string; member?: string[] },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const before = await client.listAgents(io.timeoutMs);
  const group = findRosterRow(before.agents, groupTarget, ["group"]);
  const memberAgentIds = resolveMemberIds(before.agents, raw.member ?? []);
  await setMembers(deps, client, asString(group.id), memberAgentIds, io.timeoutMs, createNonce(undefined, deps));
}
