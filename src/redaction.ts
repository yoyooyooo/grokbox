import { asBoolean, asNumber, asString, emptyToNull, isRecord, utf8Bytes } from "./util.ts";

export type AgentKind = "agent" | "group";

export function agentKind(row: Record<string, unknown>): AgentKind {
  return row.isGroup === true ? "group" : "agent";
}

export type CompactRoster = {
  id: string;
  name: string;
  title: string | null;
  kind: AgentKind;
  isHidden: boolean;
  isRunning: boolean;
  isRunningTurn: boolean;
  awaitingUserResponse: boolean;
  hasUnread: boolean;
  updatedAt: number;
};

export function compactRosterRow(row: Record<string, unknown>): CompactRoster {
  return {
    id: asString(row.id),
    name: asString(row.name),
    title: emptyToNull(row.title),
    kind: agentKind(row),
    isHidden: asBoolean(row.isHiddenFromSidebar),
    isRunning: asBoolean(row.isRunning),
    isRunningTurn: asBoolean(row.isRunningTurn),
    awaitingUserResponse: asBoolean(row.awaitingUserResponse),
    hasUnread: asBoolean(row.hasUnread),
    updatedAt: asNumber(row.updatedAt),
  };
}

export function detailRosterRow(row: Record<string, unknown>): CompactRoster & {
  description: string;
  avatarShape: string | null;
  avatarColor: string | null;
  notifyOnUpdates: boolean;
  memberIds: string[];
} {
  return {
    ...compactRosterRow(row),
    description: asString(row.description),
    avatarShape: emptyToNull(row.avatarShape),
    avatarColor: emptyToNull(row.avatarColor),
    notifyOnUpdates: asBoolean(row.notifyOnUpdatesEnabled),
    memberIds: Array.isArray(row.memberIds)
      ? row.memberIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function runningProjection(row: Record<string, unknown>, observedAtMs: number) {
  return {
    id: asString(row.id),
    kind: agentKind(row),
    isRunning: asBoolean(row.isRunning),
    isRunningTurn: asBoolean(row.isRunningTurn),
    awaitingUserResponse: asBoolean(row.awaitingUserResponse),
    isComposingMessage: asBoolean(row.isComposingMessage),
    isRetrying: asBoolean(row.isRetrying),
    observedAtMs,
  };
}

export function projectSearchHit(row: unknown): {
  agentId: string;
  entryId: string;
  role: string;
  timestampMs: number;
  snippet: string;
} {
  const rec = isRecord(row) ? row : {};
  return {
    agentId: asString(rec.agentId),
    entryId: asString(rec.entryId),
    role: asString(rec.role),
    timestampMs: asNumber(rec.timestampMs),
    snippet: asString(rec.snippet),
  };
}

export function projectMemory(
  row: unknown,
  includeContent: boolean,
): Record<string, unknown> {
  const rec = isRecord(row) ? row : {};
  const content = asString(rec.content);
  const projected: Record<string, unknown> = {
    id: asString(rec.id),
    kind: asString(rec.kind, "log"),
    createdAt: asNumber(rec.createdAt),
    contentBytes:
      typeof rec.contentBytes === "number" && Number.isFinite(rec.contentBytes)
        ? rec.contentBytes
        : utf8Bytes(content),
  };
  if (includeContent) projected.content = content;
  return projected;
}

function safeTranscriptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ["agentId", "entryId", "rootId", "role", "status", "kind"] as const) {
    if (typeof payload[key] === "string") safe[key] = payload[key];
  }
  for (const key of ["sequence", "timestampMs", "createdAt", "updatedAt"] as const) {
    if (typeof payload[key] === "number" && Number.isFinite(payload[key])) safe[key] = payload[key];
  }
  if (Array.isArray(payload.entries)) {
    safe.entries = payload.entries.filter(isRecord).map(safeTranscriptPayload);
  }
  return safe;
}

function safeTaskPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ["id", "agentId", "parentId", "status", "kind"] as const) {
    if (typeof payload[key] === "string") safe[key] = payload[key];
  }
  for (const key of ["createdAt", "updatedAt", "completedAt", "count"] as const) {
    if (typeof payload[key] === "number" && Number.isFinite(payload[key])) safe[key] = payload[key];
  }
  if (Array.isArray(payload.items)) safe.items = payload.items.filter(isRecord).map(safeTaskPayload);
  return safe;
}

export function redactEventPayload(
  channel: string,
  payload: unknown,
  includeMemoryContent: boolean,
): unknown {
  if (!isRecord(payload)) return {};
  if (channel === "agents") {
    const agents = Array.isArray(payload.agents)
      ? payload.agents.filter(isRecord).map(compactRosterRow)
      : [];
    const coverage = isRecord(payload.coverage) && typeof payload.coverage.kind === "string"
      ? { kind: payload.coverage.kind }
      : undefined;
    return { agents, ...(coverage === undefined ? {} : { coverage }) };
  }
  if (channel === "agent-upserted") {
    return { agent: isRecord(payload.agent) ? compactRosterRow(payload.agent) : null };
  }
  if (channel === "memory") {
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    if (includeMemoryContent) {
      return {
        agentId: asString(payload.agentId),
        memories: memories.map((memory) => projectMemory(memory, true)),
      };
    }
    return { agentId: asString(payload.agentId), count: memories.length };
  }
  if (channel === "transcript") return safeTranscriptPayload(payload);
  if (channel === "subagents" || channel === "async-tasks") return safeTaskPayload(payload);
  return {};
}
