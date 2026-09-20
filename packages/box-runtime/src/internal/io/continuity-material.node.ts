import { botProfile, botSupplement, materialFromBotSupplement, BOT_HISTORY_LIMIT, BOT_MEMORY_LIMIT,
  CurrentStateFailure, type BotWorkflowRequest, type BotSupplement, type NativeQualification } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { ContinuityGateway, ContinuityDiscovery } from "./continuity-gateway.node.ts";

export const botProfileRevision = (raw: unknown) => sha256Text(canonicalJson(botProfile(raw)));
/** Formal native material only. A fallback remains attributed and incomplete;
 * it cannot stand in for a verified checkpoint or mutate native Memory files. */
export function nativeMaterialReader(gateway: ContinuityGateway, check: <A>(r: { result: A; discovery: ContinuityDiscovery }) => A, timeoutMs: number) {
  const profile = async (agentId: string) => {
    const response = await gateway.listAgents(timeoutMs);
    const matches = check({ result: response.agents, discovery: response.discovery }).filter((r: any) => r?.id === agentId && r?.isGroup !== true) as any[];
    if (matches.length !== 1) throw new CurrentStateFailure("source_changed");
    const row = matches[0];
    return botProfile({ name: row.name, description: row.description ?? "", title: row.title ?? "", avatarShape: row.avatarShape ?? "", avatarColor: row.avatarColor ?? "" });
  };
  const fallback = async (request: BotWorkflowRequest, qualification: NativeQualification) => {
    if (!request.sourceId) throw new CurrentStateFailure("invalid_request");
    let memory: unknown[] = [], history: unknown[] = [], memoryComplete = false, historyComplete = false;
    try {
      const raw = check(await gateway.rpc("getAgentMemories", { id: request.sourceId }, { timeoutMs, maxResponseBytes: 512 * 1024 })) as any;
      const rows = Array.isArray(raw) ? raw : raw?.memories;
      if (Array.isArray(rows)) { memory = rows.slice(0, BOT_MEMORY_LIMIT); memoryComplete = rows.length <= BOT_MEMORY_LIMIT; }
    } catch (e) { if (e instanceof CurrentStateFailure && e.code === "source_changed") throw e; }
    try {
      const raw = check(await gateway.rpc("getAgentTranscriptTail", { id: request.sourceId, limit: BOT_HISTORY_LIMIT }, { timeoutMs, maxResponseBytes: 512 * 1024 })) as any;
      if (Array.isArray(raw?.entries)) { history = raw.entries.slice(-BOT_HISTORY_LIMIT); historyComplete = raw.hasMore === false; }
    } catch (e) { if (e instanceof CurrentStateFailure && e.code === "source_changed") throw e; }
    const cleanMemory: BotSupplement["memory"] = [], cleanHistory: BotSupplement["history"] = [];
    for (const raw of memory) {
      try {
        const m = raw as any;
        cleanMemory.push(botSupplement({ version: 1, sourceId: request.sourceId, memory: [{ content: m.content, createdAt: m.createdAt, kind: m.kind }], history: [], memoryComplete: false, historyComplete: false }).memory[0]!);
      } catch { memoryComplete = false; }
    }
    for (const raw of history) {
      try { cleanHistory.push(botSupplement({ version: 1, sourceId: request.sourceId, memory: [], history: [raw], memoryComplete: false, historyComplete: false }).history[0]!); }
      catch { historyComplete = false; }
    }
    if (!cleanMemory.length && !cleanHistory.length) throw new CurrentStateFailure("material_invalid");
    const supplement = botSupplement({ version: 1, sourceId: request.sourceId, memory: cleanMemory, history: cleanHistory, memoryComplete, historyComplete });
    return materialFromBotSupplement(supplement, { agentId: request.sourceId, scopeId: request.scopeId,
      nativeSchema: qualification.nativeSchema, contextRevision: sha256Text(canonicalJson(supplement)), capturedAtMs: Date.now(), transcriptThrough: null });
  };
  return { profile, fallback };
}
