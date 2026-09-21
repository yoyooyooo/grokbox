import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { readConfigFile } from "./config-layout.node.ts";
import type { OwnershipReader } from "./ownership-admission.node.ts";
import { createNotificationReceiver } from "./notification-receiver.node.ts";
import { reviewedProfilePath } from "./paths.ts";
import { isAbsolute } from "node:path";
import { NATIVE_ROUTINE_MAX_BYTES } from "@grokbox/runtime-kernel/routines";
import { createRoutineGateway, type RoutineRpc } from "./routine-gateway.node.ts";
import { createContinuityGatewayIO, type ContinuityRpc, type ContinuityPrograms } from "./continuity-gateway.node.ts";

export type NativeBotSummary = {
  id: string; name: string; title: string | null; description: string | null;
  nativeHarness: "box" | "temporal" | null;
  hidden: boolean | null; running: boolean | null; runningTurn: boolean | null;
  updatedAt: number | null; textTruncated: boolean; truncatedFields: Array<"name" | "title" | "description">;
};
export type NativeBotSnapshot = {
  bots: NativeBotSummary[];
  source: { kind: "native-gateway"; generation: string; pid: number; startedAt: number; observedAt: number };
  coverage: "current-snapshot";
};
export class ManagementSourceError extends Error {
  readonly _tag = "ManagementSourceError";
  constructor(readonly code: "source_unavailable" | "source_invalid" | "source_unauthorized" | "source_timeout") {
    super(code === "source_timeout" ? "The native observation deadline elapsed."
      : code === "source_unauthorized" ? "The native source rejected its configured credential."
      : code === "source_invalid" ? "The native source returned an invalid or oversized observation." : "The native source is unavailable.");
    this.name = "ManagementSourceError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unavailable = () => new ManagementSourceError("source_unavailable");
const invalid = () => new ManagementSourceError("source_invalid");

type Discovery = { baseUrl: string; token: string; pid: number; startedAt: number; generation: string };
async function discovery(path: string): Promise<Discovery> {
  let raw: unknown;
  try { raw = await readConfigFile(path); } catch { throw unavailable(); }
  if (!record(raw) || (raw.scheme !== "http" && raw.scheme !== "https") || typeof raw.host !== "string"
    || !Number.isSafeInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65535
    || !Number.isSafeInteger(raw.pid) || Number(raw.pid) < 1 || !Number.isSafeInteger(raw.startedAt) || Number(raw.startedAt) < 1
    || typeof raw.token !== "string" || !raw.token.length || raw.token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(raw.token)) throw unavailable();
  const host = raw.host.trim().toLowerCase();
  const dial = ["localhost", "127.0.0.1", "0.0.0.0", "::", "[::]", "*"].includes(host) ? "127.0.0.1"
    : ["::1", "[::1]"].includes(host) ? "[::1]" : null;
  if (!dial) throw unavailable();
  const baseUrl = `${raw.scheme}://${dial}:${raw.port}`;
  const pid = raw.pid as number, startedAt = raw.startedAt as number;
  return { baseUrl, token: raw.token, pid, startedAt, generation: sha256Text(canonicalJson({ baseUrl, pid, startedAt })) };
}

async function body(response: Response, signal: AbortSignal, maxBytes = RESPONSE_BYTES): Promise<unknown> {
  if (!response.body) throw invalid();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel(); throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ManagementSourceError("source_timeout");
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      total += next.value.byteLength;
      if (total > maxBytes) throw invalid();
      chunks.push(next.value);
    }
    if (signal.aborted) throw new ManagementSourceError("source_timeout");
    const bytes = Buffer.concat(chunks, total);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw invalid(); }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function summary(raw: Record<string, unknown>): NativeBotSummary {
  if (typeof raw.id !== "string" || !UUID.test(raw.id) || typeof raw.name !== "string") throw invalid();
  const text = (value: unknown, limit: number): string | null => typeof value === "string" ? Array.from(value).slice(0, limit).join("") : null;
  const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
  const truncatedFields = ([["name", 256], ["title", 1024], ["description", 4096]] as const)
    .filter(([field, limit]) => typeof raw[field] === "string" && Array.from(raw[field]).length > limit).map(([field]) => field);
  return {
    id: raw.id.toLowerCase(), name: text(raw.name, 256)!, title: text(raw.title, 1024), description: text(raw.description, 4096),
    nativeHarness: raw.harness === "box" || raw.harness === "temporal" ? raw.harness : null,
    hidden: flag(raw.isHiddenFromSidebar), running: flag(raw.isRunning), runningTurn: flag(raw.isRunningTurn),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 ? raw.updatedAt : null,
    textTruncated: truncatedFields.length > 0, truncatedFields,
  };
}

/** Each call re-observes local discovery. Reads are narrow projections; Routine
 * writes are exposed only through a per-operation pinned domain adapter. No
 * retries, remote fallback, caller-selected RPC or service control. */
export function createManagementGatewayIO(options: { discoveryPath: string; configurationRoot?: string; fetch?: typeof fetch; timeoutMs?: number }, programs: ContinuityPrograms) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw unavailable();
  if (options.configurationRoot !== undefined && !isAbsolute(options.configurationRoot)) throw unavailable();
  const call = async (method: "listAgents" | "getHostStatus" | "grokboxContextControl" | RoutineRpc | ContinuityRpc, input: Record<string, unknown>, parent: AbortSignal, deadlineMs = timeoutMs, maxBytes = RESPONSE_BYTES, expectedGeneration?: string) => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(Math.min(deadlineMs, method === "grokboxCurrentStateControl" || method === "grokboxContextControl" ? 180000 : timeoutMs))]);
    if (signal.aborted) throw new ManagementSourceError("source_timeout");
    const source = await discovery(options.discoveryPath);
    if (expectedGeneration !== undefined && expectedGeneration !== sha256Text(canonicalJson([source.baseUrl, source.pid, source.startedAt]))) throw invalid();
    if (signal.aborted) throw new ManagementSourceError("source_timeout");
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`${source.baseUrl}/api/${method}`, {
        method: "POST", headers: { authorization: `Bearer ${source.token}`, "content-type": "application/json", "x-sand-slim-avatars": "1" },
        body: JSON.stringify(input), redirect: "manual", signal,
      });
    } catch { throw signal.aborted ? new ManagementSourceError("source_timeout") : unavailable(); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw response.status === 401 || response.status === 403 ? new ManagementSourceError("source_unauthorized") : unavailable();
    }
    let result: unknown;
    try { result = await body(response, signal, maxBytes); }
    catch (error) { throw error instanceof ManagementSourceError ? error : signal.aborted ? new ManagementSourceError("source_timeout") : unavailable(); }
    return { result, source };
  };
  const ownershipRead: OwnershipReader = async (agentIds, signal) => {
    if (agentIds.length < 1 || agentIds.length > 32 || new Set(agentIds.map(id => id.toLowerCase())).size !== agentIds.length
      || agentIds.some(id => !UUID.test(id))) throw invalid();
    const { result, source } = await call("getHostStatus", { grokboxOwnershipAgentIds: agentIds }, signal);
    if (!record(result) || !Object.hasOwn(result, "grokboxOwnership")) throw invalid();
    return { snapshot: result.grokboxOwnership, gateway: { pid: source.pid, startedAt: source.startedAt } };
  };
  const receiver = createNotificationReceiver({
    readProfile: () => {
      if (!options.configurationRoot) return Promise.reject(unavailable());
      return readConfigFile(reviewedProfilePath(options.configurationRoot));
    },
    call: (method, input, signal, remaining) => call(method, input, signal, remaining, NATIVE_ROUTINE_MAX_BYTES),
  });
  return {
    ownershipRead,
    readHostWitness: async (challenge: string, signal: AbortSignal) => {
      if (!UUID.test(challenge)) throw invalid();
      const { result, source } = await call("getHostStatus", { grokboxHealthChallenge: challenge }, signal, 3000, 64 * 1024);
      if (!record(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result, "grokboxHostHealth")) throw invalid();
      return { value: result.grokboxHostHealth, pid: source.pid };
    },
    readNotificationReceiver: receiver.readExplicit,
    routineAccess: createRoutineGateway(call),
    continuityAccess: (signal: AbortSignal) => {
      if (!options.configurationRoot) throw unavailable();
      return createContinuityGatewayIO(call, options.configurationRoot, signal, programs);
    },
    listBots: async (signal: AbortSignal): Promise<NativeBotSnapshot> => {
      const { result, source } = await call("listAgents", {}, signal);
      if (!Array.isArray(result) || result.length > 4096 || result.some(row => !record(row))) throw invalid();
      const bots = (result as Record<string, unknown>[]).filter(row => row.isGroup !== true).map(summary);
      if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw invalid();
      return { bots, source: { kind: "native-gateway", generation: source.generation, pid: source.pid, startedAt: source.startedAt, observedAt: Date.now() }, coverage: "current-snapshot" };
    },
  };
}
