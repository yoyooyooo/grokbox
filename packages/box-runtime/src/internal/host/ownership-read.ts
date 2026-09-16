import { createHash } from "node:crypto";
import { OWNERSHIP_MAX_TARGETS, OWNERSHIP_WAIT_MS, OWNERSHIP_SERVER_CACHE_MS, OWNERSHIP_READ_SOURCE, projectOwnershipReadObservation, type OwnershipReadObservation } from "@grokbox/runtime-kernel/contract";

// Native credential owner only. No caller-provided evidence can authorize execution.
export const HOST_OWNERSHIP_READ_SYMBOL = "grokbox.box-runtime.ownership-read.v1";
export const OWNERSHIP_READ_MAX_AGENTS = OWNERSHIP_MAX_TARGETS;
export const OWNERSHIP_READ_DEADLINE_MS = OWNERSHIP_WAIT_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReadPorts = {
  agentIds: unknown;
  listServer: (signal: AbortSignal) => Promise<unknown>;
  readLocal: (agentId: string) => unknown;
  readWindow: () => unknown;
  readScope?: () => unknown | Promise<unknown>;
  readExecution?: () => unknown;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function own(value: unknown, key: string): unknown {
  if (!record(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function id(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}
function harness(value: unknown): "box" | "temporal" | "unknown" {
  return value === "box" || value === "temporal" ? value : "unknown";
}
function timestamp(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function local(value: unknown) {
  return { harness: harness(own(value, "harness")), serverId: id(own(value, "serverId")) };
}
function window(value: unknown) {
  const kind = own(value, "kind");
  if (kind === "inactive") return { kind: "inactive" as const };
  if (kind === "active") {
    const status = own(value, "status");
    return { kind: "active" as const, status: status === "ready" || status === "busy" || status === "fence_open" ? status : "unknown" };
  }
  return { kind: "unknown" as const };
}
function safeLocal(ports: ReadPorts, agentId: string) {
  try { return local(ports.readLocal(agentId)); } catch { return local(null); }
}
function safeWindow(ports: ReadPorts) {
  try { return window(ports.readWindow()); } catch { return window(null); }
}
function safeExecution(ports: ReadPorts) {
  try {
    const value = ports.readExecution?.();
    const allowed = own(value, "allowed"), bound = own(value, "bound");
    return { allowed: typeof allowed === "boolean" ? allowed : null, bound: typeof bound === "boolean" ? bound : null };
  } catch { return { allowed: null, bound: null }; }
}
function scopeDigest(value: unknown): string | null {
  const backend = own(value, "backend"), account = own(value, "account"), team = own(value, "team"), machine = own(value, "machine");
  if (typeof backend !== "string" || !backend.length || backend.length > 2048
    || typeof account !== "string" || !/^[a-f0-9]{64}$/.test(account)
    || !(team === null || team === undefined || typeof team === "number" && Number.isSafeInteger(team) || typeof team === "string" && team.length <= 128)
    || typeof machine !== "string" || !machine.length || machine.length > 256) return null;
  // Only this digest escapes. No token, account/team/machine id or URL is returned.
  return createHash("sha256").update(JSON.stringify([backend, account, team == null ? null : String(team), machine])).digest("hex");
}
const serverRow = (row: unknown) => ({
  agentId: id(own(row, "agentId")), id: id(own(row, "id")), harness: harness(own(row, "harness")),
  legacyAgentId: id(own(row, "legacyAgentId")), createdAtMs: timestamp(own(row, "createdAtMs")), updatedAtMs: timestamp(own(row, "updatedAtMs")),
  viewerIsOwner: typeof own(row, "viewerIsOwner") === "boolean" ? own(row, "viewerIsOwner") as boolean : null,
});
type ServerRows = ReturnType<typeof serverRow>[];

export function bindHostOwnershipRead(options: { timeoutMs?: number; now?: () => number; cacheMs?: number } = {}) {
  const timeoutMs = Math.max(1, Math.min(OWNERSHIP_READ_DEADLINE_MS, options.timeoutMs ?? OWNERSHIP_READ_DEADLINE_MS));
  const cacheMs = Math.max(0, Math.min(OWNERSHIP_SERVER_CACHE_MS, options.cacheMs ?? 0));
  const now = options.now ?? Date.now;
  let cache: { scope: string; at: number; rows: ServerRows } | undefined;
  let pending: { scope: string | null; task: Promise<ServerRows>; expired: boolean; at: number } | undefined;

  return async (ports: ReadPorts) => {
    const ids = ports.agentIds;
    const started = now();
    const observedAt = new Date(started).toISOString();
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > OWNERSHIP_READ_MAX_AGENTS
      || ids.some(value => typeof value !== "string" || !UUID.test(value)) || new Set(ids).size !== ids.length) {
      return { schemaVersion: 1, observedAt, state: "invalid_request", agents: [], readObservation: projectOwnershipReadObservation({
        version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "invalid_request", phase: "input", serverRead: "not_started",
        durationMs: Math.max(0, now() - started), deadlineMs: timeoutMs,
      }) };
    }
    // Legacy unscoped readers remain diagnostic only; v2 execution refuses them.
    if (!ports.readScope && pending) return { schemaVersion: 1, observedAt, state: "busy", agents: [], readObservation: projectOwnershipReadObservation({
      version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "busy", phase: "input", serverRead: "not_started",
      durationMs: Math.max(0, now() - started), deadlineMs: timeoutMs,
    }) };
    const before = ids.map(agentId => safeLocal(ports, agentId));
    const windowBefore = safeWindow(ports);
    const executionBefore = safeExecution(ports);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scope: string | null = null;
    let scopeAfter: string | null = null;
    let raw: ServerRows = [];
    let serverAt = started;
    let failure: string | null = null;
    let phase: OwnershipReadObservation["phase"] = "scope_before";
    let serverRead: OwnershipReadObservation["serverRead"] = "not_started";
    let serverWaitStarted: number | undefined;
    let serverWaitMs: number | undefined;
    let rpcCode: unknown;
    let serverReturned = false;
    const controller = new AbortController();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    });
    try {
      const work = async () => {
        scope = ports.readScope ? scopeDigest(await ports.readScope()) : null;
        if (controller.signal.aborted) throw new Error("timeout");
        if (ports.readScope && !scope) { failure = "scope_unavailable"; return; }
        const at = now();
        phase = "server";
        if (scope && cache && cache.scope === scope && at >= cache.at && at - cache.at < cacheMs) {
          raw = cache.rows; serverAt = cache.at; serverRead = "cache"; serverReturned = true;
        } else {
          if (pending && (pending.scope !== scope || pending.expired)) { failure = "busy"; return; }
          serverRead = pending ? "shared" : "request";
          serverWaitStarted = now();
          if (!pending) {
            // Without a Server-supplied snapshot revision/time, age the evidence
            // from request start. A late response must not renew its own freshness.
            const entry = { scope, expired: false, at: now(), task: undefined as unknown as Promise<ServerRows> };
            // Keep ownership of an uncooperative native read until it actually
            // settles. Timeout must not spawn arbitrarily many orphan RPCs.
            entry.task = Promise.resolve().then(() => ports.listServer(controller.signal)).then(response => {
              const agents = own(response, "agents");
              if (!Array.isArray(agents) || agents.length > 100_000) throw new Error("invalid_response");
              const rows = agents.map(serverRow);
              if (!controller.signal.aborted && entry.scope && cacheMs > 0
                && now() >= entry.at && now() - entry.at < cacheMs) cache = { scope: entry.scope, at: entry.at, rows };
              return rows;
            }).finally(() => { if (pending === entry) pending = undefined; });
            // Silence only the background task's unhandled rejection; callers
            // still await the original promise and receive its actual failure.
            void entry.task.catch(() => undefined);
            pending = entry;
          }
          const entry = pending;
          try { raw = await entry.task; serverAt = entry.at; serverReturned = true; }
          finally {
            serverWaitMs = Math.max(0, now() - serverWaitStarted);
            if (controller.signal.aborted) entry.expired = true;
          }
        }
        if (controller.signal.aborted) throw new Error("timeout");
        phase = "scope_after";
        scopeAfter = ports.readScope ? scopeDigest(await ports.readScope()) : null;
        if (ports.readScope && (!scopeAfter || scopeAfter !== scope)) { cache = undefined; failure = "scope_changed"; }
      };
      await Promise.race([work(), timeout]);
    } catch (error) {
      const code = own(error, "code");
      rpcCode = code;
      failure = controller.signal.aborted ? "timeout" : code === 16 || code === 7 ? "authorization_unavailable"
        : code === 12 ? "unsupported_rpc" : error instanceof Error && error.message === "invalid_response" ? "invalid_response" : "server_read_failed";
      cache = undefined;
      if (controller.signal.aborted && pending) pending.expired = true;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    const windowAfter = safeWindow(ports);
    const executionAfter = safeExecution(ports);
    if (failure !== null) raw = [];
    const completed = now();
    const readObservation = projectOwnershipReadObservation({
      version: 1, source: OWNERSHIP_READ_SOURCE, state: failure === null ? "observed" : "unavailable", errorCode: failure,
      phase: failure === null ? "complete" : phase, serverRead, rpcCode,
      durationMs: Math.max(0, completed - started), deadlineMs: timeoutMs,
      serverWaitMs: serverWaitMs ?? (serverWaitStarted !== undefined ? Math.max(0, completed - serverWaitStarted) : undefined),
      ...(serverReturned ? { serverEvidenceAgeMs: Math.max(0, completed - serverAt) } : {}),
    });
    return {
      schemaVersion: ports.readScope && ports.readExecution ? 3 : ports.readScope ? 2 : 1,
      observedAt, completedAt: new Date(completed).toISOString(),
      ...(ports.readScope ? { scope: { id: scope, stable: scope !== null && scope === scopeAfter && failure === null }, serverObservedAt: new Date(serverAt).toISOString() } : {}),
      state: failure === null ? "observed" : "unavailable",
      source: OWNERSHIP_READ_SOURCE, errorCode: failure, readObservation,
      localMigrationWindow: { before: windowBefore, after: windowAfter }, serverMigration: "not_observed",
      ...(ports.readExecution ? { localExecution: { before: executionBefore, after: executionAfter } } : {}),
      agents: ids.map((agentId: string, index: number) => {
        const matches = raw.filter(row => row.agentId === agentId);
        const row = matches.length === 1 ? matches[0] : undefined;
        const server = row ? { agentId, serverId: row.id, harness: row.harness, legacyAgentId: row.legacyAgentId,
          createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, viewerIsOwner: row.viewerIsOwner } : null;
        const after = safeLocal(ports, agentId);
        return { agentId, server, serverEvidence: failure !== null ? "unavailable" : matches.length === 0 ? "not_returned" : matches.length > 1 ? "ambiguous" : "found",
          local: { before: before[index], after, stable: JSON.stringify(before[index]) === JSON.stringify(after) } };
      }),
    };
  };
}
