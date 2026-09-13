import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { compactRosterRow, detailRosterRow } from "../redaction.ts";
import { asString, isRecord } from "../util.ts";
import {
  applyRosterSettings,
  assertAnyAttribute,
  confirmDeletion,
  createNonce,
  createProfile,
  hasProfilePatch,
  mergedProfile,
  validateRosterSettings,
  type RosterAttributes,
} from "./management.ts";
import { findRosterRow } from "./roster.ts";
import { projectOwnership } from "../ownership.ts";

export async function runAgentsList(
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
    .filter((row) => row.kind === "agent")
    .filter((row) => includeHidden || !row.isHidden);
  const data = { count: projected.length, agents: projected };
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

export async function runAgentsShow(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, ["agent"]);
  writeSuccess(deps.stdout, { agent: detailRosterRow(row) }, gatewayMeta(discovery));
}

export async function runAgentsCreate(
  deps: CliDeps,
  raw: RosterAttributes & { json?: boolean; timeoutMs?: string; nonce?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  validateRosterSettings(raw);
  const client = new GatewayClient(deps);
  const operationId = createNonce(raw.nonce, deps);
  const body: Record<string, unknown> = { ...createProfile(raw), clientNonce: operationId };
  const created = await client.createAgent(body, io.timeoutMs, operationId);
  if (!isRecord(created.result) || !isRecord(created.result.agent)) {
    throw new CliError("gateway_internal", "Gateway createAgent response has the wrong shape.");
  }
  const id = asString(created.result.agent.id);
  if (id.length === 0) throw new CliError("gateway_internal", "Gateway created agent lacks an ID.");
  try {
    await applyRosterSettings(client, id, raw, io.timeoutMs, operationId);
    const current = await client.listAgents(io.timeoutMs);
    const agent = detailRosterRow(findRosterRow(current.agents, id, ["agent"]));
    let snapshot: unknown;
    let gatewayChanged = current.discovery.pid !== created.discovery.pid || current.discovery.startedAt !== created.discovery.startedAt;
    try {
      const identity = await client.getAgentOwnership([id], io.timeoutMs);
      snapshot = identity.result;
      gatewayChanged ||= identity.discovery.pid !== current.discovery.pid || identity.discovery.startedAt !== current.discovery.startedAt;
    } catch { /* Created is a fact; unavailable read-back must not create/delete again. */ }
    const ownership = projectOwnership({ agentIds: [id], snapshot, gatewayChanged });
    const actual = ownership.agents[0];
    const requestedHarness = body.harness;
    const ownershipConfirmed = actual?.state === `confirmed_${requestedHarness}`;
    writeSuccess(deps.stdout, { agent,
      creation: { operationId, created: true, requestedHarness, ownershipConfirmed,
        outcome: ownershipConfirmed ? "created_ownership_confirmed" : actual?.state === "conflict" || actual?.state.startsWith("confirmed_") ? "created_ownership_mismatch" : "created_ownership_unconfirmed",
        managedEnabled: false }, ownership,
    }, gatewayMeta(current.discovery));
  } catch (error) {
    throw new CliError("operation_outcome_unknown", "Agent was created but its final settings or projection could not be reconciled.", {
      context: {
        operationId,
        object: { id, kind: "agent" },
        phase: "post-create",
        ...(error instanceof CliError ? { causeCode: error.code } : {}),
      },
    });
  }
}

export async function runAgentsUpdate(
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
  const row = findRosterRow(before.agents, target, ["agent"]);
  const id = asString(row.id);
  if (hasProfilePatch(raw)) {
    const updated = await client.updateAgent({ id, profile: mergedProfile(row, raw) }, io.timeoutMs, operationId);
    if (updated.result === null) throw new CliError("target_not_found", "Agent disappeared before update.");
  }
  await applyRosterSettings(client, id, raw, io.timeoutMs, operationId);
  const current = await client.listAgents(io.timeoutMs);
  const agent = detailRosterRow(findRosterRow(current.agents, id, ["agent"]));
  writeSuccess(deps.stdout, { agent }, gatewayMeta(current.discovery));
}

export async function runAgentsDelete(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; yes?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const before = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(before.agents, target, ["agent"]);
  await confirmDeletion(deps, raw.yes, "agent", row);
  const deleted = await client.deleteAgent(asString(row.id), io.timeoutMs, createNonce(undefined, deps));
  writeSuccess(
    deps.stdout,
    { deleted: { id: asString(row.id), name: asString(row.name), kind: "agent" } },
    gatewayMeta(deleted.discovery),
  );
}
