import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { detailRosterRow } from "../redaction.ts";
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
import {
  applyAgentTitles,
  loadTitleModelIndex,
  readOwnershipStates,
  rosterTitleProjection,
  titleSyncModel,
  titleSyncEffort,
  type TitleAction,
} from "../title-sync.ts";
import { composeAgentTitle, labelOwnerFromState, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { liveDesktopIo, readDesktopReap, reapDeletedAgentSeat, type DesktopReapResult } from "../daemon/desktop.ts";

export async function runAgentsContext(deps: CliDeps, action: "status" | "compact", target: string,
  raw: { json?: boolean; timeoutMs?: string; session?: string; operationId?: string; confirm?: boolean }): Promise<void> {
  if (!target) throw usage("An Agent is required.");
  if (raw.session !== undefined && (raw.session.length > 128 || /[\x00-\x1f]/.test(raw.session))) throw usage("Invalid session identity.");
  if (raw.operationId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(raw.operationId)) throw usage("Invalid operation identity.");
  if (action === "compact" && (!raw.operationId || raw.confirm !== true)) throw usage("Compaction requires --operation-id and --confirm; it can incur model cost.");
  const io = ioFromOpts({ ...raw, timeoutMs: raw.timeoutMs ?? (action === "compact" ? "180000" : "15000") });
  const client = new GatewayClient(deps);
  let agentId = target;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    agentId = asString(findRosterRow((await client.listAgents(io.timeoutMs)).agents, target, ["agent"]).id);
  }
  const { result, discovery } = await client.contextControl({ action, agentId,
    ...(raw.session !== undefined ? { sessionId: raw.session } : {}),
    ...(raw.operationId !== undefined ? { operationId: raw.operationId } : {}),
    ...(action === "compact" ? { confirm: true } : {}) }, io.timeoutMs);
  if (!isRecord(result) || typeof result.ok !== "boolean") throw new CliError("capability_unavailable", "Host context maintenance capability is unavailable.");
  if (!result.ok) {
    const reason = isRecord(result.error) && typeof result.error.code === "string" && /^[a-z_]{1,64}$/.test(result.error.code) ? result.error.code : "capability_unqualified";
    throw new CliError(reason === "commit_unknown" ? "operation_outcome_unknown" : "capability_unavailable", "Context operation did not complete.", {
      hostReason: reason,
      next: action === "compact" ? "Inspect this operation with agents context; do not create a new operation to replay an unknown result." : "Verify the loaded Host/modeld capability and exact session.",
      ...(raw.operationId ? { context: { operationId: raw.operationId, object: { id: agentId, kind: "agent" as const }, phase: "context-maintenance" } } : {}),
    });
  }
  writeSuccess(deps.stdout, result.data, gatewayMeta(discovery));
}

export async function runAgentsList(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string; includeHidden?: boolean; ownership?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const includeHidden = Boolean(raw.includeHidden);
  const projected = agents
    .filter(isRecord)
    .map(rosterTitleProjection)
    .filter((row) => row.kind === "agent")
    .filter((row) => includeHidden || !row.isHidden);
  let ownership: Awaited<ReturnType<typeof readOwnershipStates>> | undefined;
  if (raw.ownership) {
    ownership = await readOwnershipStates(client, projected.map((row) => row.id), io.timeoutMs, discovery);
  }
  const agentsOut = projected.map((row) => ({
    ...row,
    ...(ownership ? { ownership: ownership.states.get(row.id) ?? "unconfirmed" } : {}),
  }));
  const data = { count: agentsOut.length, agents: agentsOut, ...(ownership ? { gatewayChanged: ownership.gatewayChanged } : {}) };
  if (io.table) {
    deps.stdout.write(
      formatTable(
        agentsOut.map((row) => ({
          id: row.id,
          name: row.name,
          title: row.title ?? "",
          harness: row.harness,
          owner: row.titleOwner ?? "",
          m: row.titleModel ?? "",
          ...(ownership ? { ownership: "ownership" in row ? String(row.ownership) : "unconfirmed" } : {}),
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
  raw: { json?: boolean; timeoutMs?: string; ownership?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const { agents, discovery } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, ["agent"]);
  const agent = rosterTitleProjection(row);
  let ownership: Awaited<ReturnType<typeof readOwnershipStates>> | undefined;
  if (raw.ownership) {
    ownership = await readOwnershipStates(client, [agent.id], io.timeoutMs, discovery);
  }
  writeSuccess(deps.stdout, {
    agent: {
      ...detailRosterRow(row),
      titleUser: agent.titleUser,
      titleShowing: agent.titleShowing,
      titleOwner: agent.titleOwner,
      titleModel: agent.titleModel,
      titleStale: agent.titleStale,
      ...(ownership ? { ownership: ownership.states.get(agent.id) ?? "unconfirmed" } : {}),
    },
  }, gatewayMeta(discovery));
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
    const currentRow = findRosterRow(current.agents, id, ["agent"]);
    let agent = { ...detailRosterRow(currentRow), ...rosterTitleProjection(currentRow) };
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
    const profile = mergedProfile(row, raw);
    if (raw.title !== undefined && parseAgentTitle(row.title).showing) {
      const { tokens, assigned, efforts } = await loadTitleModelIndex(deps.boxRuntimeRoot, deps.env);
      let owner: ReturnType<typeof labelOwnerFromState> = "leave";
      try {
        const identity = await readOwnershipStates(client, [id], io.timeoutMs, before.discovery);
        const state = identity.states.get(id);
        if (state) owner = labelOwnerFromState(state);
      } catch { /* Keep the existing trailer if ownership cannot be refreshed. */ }
      const composed = composeAgentTitle(row.title, {
        type: "set-user",
        user: raw.title,
        owner,
        m: titleSyncModel(owner, id, tokens, assigned),
        e: titleSyncEffort(owner, id, efforts, assigned),
      });
      profile.title = composed.title;
    }
    const updated = await client.updateAgent({ id, profile }, io.timeoutMs, operationId);
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
  const id = asString(row.id);
  const deleted = await client.deleteAgent(id, io.timeoutMs, createNonce(undefined, deps));
  const desktop = readDesktopReap(deleted.result) ?? await reapDesktopAfterDelete(deps, id);
  writeSuccess(
    deps.stdout,
    { deleted: { id, name: asString(row.name), kind: "agent" }, ...(desktop ? { desktop } : {}) },
    gatewayMeta(deleted.discovery),
  );
}

/** Box-local Profiles may reap this machine's seats; SSH / remote daemon must not. */
export function isBoxLocalDesktopReap(
  deps: Pick<CliDeps, "transport" | "sshHost" | "daemonServerUrl">,
): boolean {
  return (deps.transport === "local" || deps.transport === "auto")
    && !deps.sshHost
    && !deps.daemonServerUrl;
}

async function reapDesktopAfterDelete(deps: CliDeps, agentId: string): Promise<DesktopReapResult | undefined> {
  if (!isBoxLocalDesktopReap(deps)) return undefined;
  const io = deps.desktopIo ?? await liveDesktopIo();
  if (!io) return { display: null, outcome: "unavailable" };
  return await reapDeletedAgentSeat(agentId, deps.now(), io);
}

export async function runAgentsTitle(
  deps: CliDeps,
  action: TitleAction,
  targets: string[],
  raw: { json?: boolean; table?: boolean; timeoutMs?: string; dryRun?: boolean; all?: boolean },
): Promise<void> {
  const names = targets.map((target) => target.trim()).filter((target) => target.length > 0);
  const all = Boolean(raw.all);
  if (all && names.length > 0) throw usage("Do not combine --all with named agents.");
  if (action === "show" && !all && names.length === 0) throw usage("title show requires agents or --all.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const listed = await client.listAgents(io.timeoutMs);
  const roster = listed.agents.filter(isRecord).filter((row) => row.isGroup !== true);
  let rows: Record<string, unknown>[];
  if (names.length > 0) {
    rows = names.map((name) => findRosterRow(listed.agents, name, ["agent"]));
  } else if (action === "sync") {
    rows = roster.filter((row) => parseAgentTitle(row.title).showing);
  } else {
    rows = roster;
  }
  const { tokens, assigned, efforts } = action === "hide"
    ? { tokens: new Map<string, string>() }
    : await loadTitleModelIndex(deps.boxRuntimeRoot, deps.env);
  const applied = await applyAgentTitles(client, io.timeoutMs, {
    action,
    rows,
    dryRun: Boolean(raw.dryRun),
    tokens,
    assigned,
    efforts,
  });
  const written = applied.rows.filter((row) => row.written).length;
  const skippedRows = applied.rows.filter((row) => row.skipped);
  const skipped = skippedRows.length;
  const pending = applied.rows.filter((row) => row.changed && !row.written).length;
  const skips = skippedRows.map((row) => ({
    agent: row.name || row.agentId,
    id: row.agentId,
    reason: row.skipped,
  }));
  const data = {
    action,
    dryRun: Boolean(raw.dryRun),
    examined: applied.rows.length,
    written,
    skipped,
    ...(raw.dryRun ? { pending } : {}),
    ...(skips.length > 0 ? { skips } : {}),
  };
  if (io.table) {
    deps.stdout.write(
      formatTable(
        skips.length === 0
          ? [
              {
                action,
                examined: String(data.examined),
                written: String(written),
                skipped: String(skipped),
                ...(raw.dryRun ? { pending: String(pending) } : {}),
              },
            ]
          : skips.map((row) => ({
              agent: row.agent,
              id: row.id,
              reason: String(row.reason ?? ""),
            })),
      ),
    );
    return;
  }
  writeSuccess(deps.stdout, data, gatewayMeta(listed.discovery));
}
