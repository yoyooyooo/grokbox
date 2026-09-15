import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  composeAgentTitle,
  chunkOwnershipTargets,
  labelOwnerFromState,
  parseAgentTitle,
  type LabelOwner,
  type OwnershipState,
} from "@grokbox/runtime-kernel/contract";
import { assignedModelTokens } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "@grokbox/box-runtime/runtime";
import type { GatewayClient } from "./gateway.ts";
import { projectOwnership } from "./ownership.ts";
import { compactRosterRow, detailRosterRow } from "./redaction.ts";
import { asString, isRecord } from "./util.ts";

const AGENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TitleAction = "show" | "hide" | "sync";

export type TitleSyncRow = {
  agentId: string;
  name: string;
  from: string;
  to: string;
  showing: boolean;
  owner: LabelOwner | "leave" | "skipped";
  m: string | null;
  ownership: OwnershipState | "skipped";
  skipped?: "unconfirmed" | "hidden";
  changed: boolean;
  written: boolean;
};

export function rosterTitleProjection(row: Record<string, unknown>) {
  const compact = compactRosterRow(row);
  const parsed = parseAgentTitle(compact.title);
  return {
    ...compact,
    titleUser: parsed.user,
    titleShowing: parsed.showing,
    titleOwner: parsed.showing ? parsed.fields.owner ?? null : null,
    titleModel: parsed.showing ? parsed.fields.m ?? null : null,
    titleStale: compact.harness === "temporal" && parsed.showing && parsed.fields.owner === "box",
  };
}

/** Display owner for a title write. Live Server class wins; otherwise roster, trailer, model, or user text. */
export function titlePaintOwner(
  row: Record<string, unknown>,
  ownership: OwnershipState | undefined,
  token?: string,
): LabelOwner | "leave" {
  if (ownership !== undefined) {
    const live = labelOwnerFromState(ownership);
    if (live !== "leave") return live;
  }
  const harness = compactRosterRow(row).harness;
  if (harness === "box" || harness === "temporal") return harness;
  const parsed = parseAgentTitle(row.title);
  if (parsed.fields.owner !== undefined) return parsed.fields.owner;
  if (typeof token === "string" && token.length > 0) return "box";
  if (parsed.user.length > 0 || parsed.showing) return "box";
  return "leave";
}

/** Explicit `title show` still paints a trailer-only `owner=box` when no better display owner exists. */
export function titleShowOwner(
  row: Record<string, unknown>,
  ownership: OwnershipState | undefined,
  token?: string,
): LabelOwner {
  const inferred = titlePaintOwner(row, ownership, token);
  return inferred === "leave" ? "box" : inferred;
}

export async function readOwnershipStates(
  client: GatewayClient,
  agentIds: readonly string[],
  timeoutMs: number,
  discovery: { pid: number; startedAt: number },
): Promise<{ states: Map<string, OwnershipState>; gatewayChanged: boolean }> {
  const states = new Map<string, OwnershipState>();
  const uuids = agentIds.filter((id) => AGENT_UUID.test(id));
  let gatewayChanged = false;
  for (const batch of chunkOwnershipTargets(uuids)) {
    const observation = await client.getAgentOwnership(batch, timeoutMs);
    gatewayChanged ||= observation.discovery.pid !== discovery.pid || observation.discovery.startedAt !== discovery.startedAt;
    const projected = projectOwnership({ agentIds: batch, snapshot: observation.result, gatewayChanged });
    for (const agent of projected.agents) states.set(agent.agentId, agent.state);
  }
  return { states, gatewayChanged };
}

export function profileWriteFromRoster(row: Record<string, unknown>, title: string): Record<string, unknown> {
  const detail = detailRosterRow(row);
  const profile: Record<string, unknown> = {
    name: detail.name,
    description: detail.description,
    title,
  };
  if (detail.avatarShape) profile.avatarShape = detail.avatarShape;
  if (detail.avatarColor) profile.avatarColor = detail.avatarColor;
  return profile;
}

export type TitleModelIndex = {
  tokens: Map<string, string>;
  /** Lowercased agent ids with a models.json assignment. Omitted when the snapshot is unavailable. */
  assigned?: Set<string>;
};

/** Load label tokens and assignment presence. A missing/unreadable snapshot omits `assigned`. */
export async function loadTitleModelIndex(
  boxRuntimeRoot: string,
  env: NodeJS.Dict<string>,
): Promise<TitleModelIndex> {
  try {
    const store = openRuntimeStore(boxRuntimeRoot, env);
    try {
      await access(join(store.root, "models.json"));
    } catch {
      return { tokens: new Map() };
    }
    const file = await store.loadModels();
    return {
      tokens: assignedModelTokens(file),
      assigned: new Set(Object.keys(file.assignments.agents).map((id) => id.toLowerCase())),
    };
  } catch {
    return { tokens: new Map() };
  }
}

export async function loadAssignedModelTokens(
  boxRuntimeRoot: string,
  env: NodeJS.Dict<string>,
): Promise<Map<string, string>> {
  return (await loadTitleModelIndex(boxRuntimeRoot, env)).tokens;
}

/** Compose `m`: string paints, `null` clears, omit/`undefined` preserves a transient miss. */
export function titleSyncModel(
  owner: LabelOwner | "leave",
  agentId: string,
  tokens: Map<string, string>,
  assigned?: ReadonlySet<string>,
): string | null | undefined {
  if (owner === "leave") return undefined;
  if (owner !== "box") return null;
  const id = agentId.toLowerCase();
  if (!id) return undefined;
  if (assigned !== undefined && !assigned.has(id)) return null;
  return tokens.get(id);
}

const MODEL_TITLE_TIMEOUT_MS = 10_000;

/** Command-driven Label paint after a per-Bot model assignment. Display-only: never fail the selection. */
export async function paintTitleAfterModelAssignment(
  client: GatewayClient,
  input: { agentId: string; boxRuntimeRoot: string; env: NodeJS.Dict<string>; mode: "custom" | "official" },
): Promise<Record<string, unknown>> {
  try {
    const listed = await client.listAgents(MODEL_TITLE_TIMEOUT_MS);
    const row = listed.agents.filter(isRecord).find((item) => asString(item.id).toLowerCase() === input.agentId.toLowerCase());
    if (!row) return { skipped: "no_roster" };
    const { tokens, assigned } = await loadTitleModelIndex(input.boxRuntimeRoot, input.env);
    const applied = await applyAgentTitles(client, MODEL_TITLE_TIMEOUT_MS, {
      action: input.mode === "custom" ? "show" : "sync",
      rows: [row],
      tokens,
      assigned,
    });
    const painted = applied.rows[0];
    if (!painted) return { skipped: "no_roster" };
    return {
      from: painted.from,
      to: painted.to,
      written: painted.written,
      showing: painted.showing,
      m: painted.m,
      ...(painted.skipped ? { skipped: painted.skipped } : {}),
    };
  } catch {
    return { skipped: "title_write_failed" };
  }
}

export async function applyAgentTitles(
  client: GatewayClient,
  timeoutMs: number,
  input: {
    action: TitleAction;
    rows: Record<string, unknown>[];
    dryRun?: boolean;
    tokens?: Map<string, string>;
    assigned?: ReadonlySet<string>;
  },
): Promise<{ rows: TitleSyncRow[] }> {
  const tokens = input.tokens ?? new Map<string, string>();
  const needOwnership = input.action !== "hide";
  const ids = input.rows.map((row) => asString(row.id)).filter((id) => AGENT_UUID.test(id));
  const states = new Map<string, OwnershipState>();
  if (needOwnership && ids.length > 0) {
    try {
      for (const batch of chunkOwnershipTargets(ids)) {
        const observation = await client.getAgentOwnership(batch, timeoutMs);
        const projected = projectOwnership({ agentIds: batch, snapshot: observation.result });
        for (const agent of projected.agents) states.set(agent.agentId, agent.state);
      }
    } catch {
      /* Display-only: a failed Server read still paints from roster, trailer, or model. */
    }
  }
  const rows: TitleSyncRow[] = [];
  for (const row of input.rows) {
    const agentId = asString(row.id);
    const name = asString(row.name);
    const from = typeof row.title === "string" ? row.title.trim() : "";
    const ownership = states.get(agentId) ?? (needOwnership && AGENT_UUID.test(agentId) ? "unconfirmed" : undefined);
    const token = tokens.get(agentId.toLowerCase());
    const owner = input.action === "show"
      ? titleShowOwner(row, ownership, token)
      : titlePaintOwner(row, ownership, token);
    const composed = input.action === "hide"
      ? composeAgentTitle(from, { type: "hide" })
      : input.action === "show" && owner !== "leave"
        ? composeAgentTitle(from, { type: "show", owner, m: owner === "box" ? token ?? null : null })
        : composeAgentTitle(from, { type: "sync", owner, m: titleSyncModel(owner, agentId, tokens, input.assigned) });
    let written = false;
    if (composed.changed && input.dryRun !== true) {
      await client.updateAgent({ id: agentId, profile: profileWriteFromRoster(row, composed.title) }, timeoutMs);
      written = true;
    }
    rows.push({
      agentId,
      name,
      from,
      to: composed.title,
      showing: composed.showing,
      owner,
      m: parseAgentTitle(composed.title).fields.m ?? null,
      ownership: ownership ?? "skipped",
      skipped: composed.skipped,
      changed: composed.changed,
      written,
    });
  }
  return { rows };
}
