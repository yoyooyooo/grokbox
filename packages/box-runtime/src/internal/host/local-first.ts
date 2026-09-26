import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { isContinuityUuid } from "@grokbox/runtime-kernel/continuity";
import type { LocalFirstReceipt } from "@grokbox/runtime-kernel/products";

export const HOST_LOCAL_FIRST_SYMBOL = "grokbox.native-local-first.v1";
type Row = Record<string, any>;
type Ports = {
  createBackgroundAgent: (profile: Row, origin: string, options: Row) => Promise<{ agent: Row; transcript: unknown[] }>;
  listAgents: () => Promise<Row[]>;
};
type Identity = { isWriteEnabled: () => Promise<boolean>; ensureServerBacked: (id: string) => Promise<Row> };
const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const harness = (v: unknown) => v === "box" || v === "temporal" ? v : null;
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x1f]/.test(v) ? v : null;

/** Host leaf: original native writers only. The management CONT ledger owns
 * durable admission. This bounded generation-local cache only recovers a lost
 * response by the original operation ID; cache absence never permits replay. */
export function createLocalFirstBridge(source: LocalFirstReceipt["source"]) {
  type Entry = { declaration: string; receipt: LocalFirstReceipt; promise?: Promise<unknown>; args: Row };
  const entries = new Map<string, Entry>(), context = new AsyncLocalStorage<Entry>();
  const read = (operationId: unknown) => typeof operationId === "string" && entries.has(operationId)
    ? structuredClone(entries.get(operationId)!.receipt) : null;
  async function create(args: Row, profile: Row, options: Row, manager: Ports, identity: Identity): Promise<unknown> {
    if (args.harness !== "box" || !isContinuityUuid(args.clientNonce)) throw Error("local_first_original_request_required");
    const declaration = canonicalJson(args), prior = entries.get(args.clientNonce);
    if (prior) {
      if (prior.declaration !== declaration) throw Error("local_first_request_conflict");
      return prior.promise;
    }
    if (entries.size >= 64) throw Error("local_first_receipt_capacity");
    // Never invent identity registration authority or fall back to another mint.
    if (!await identity.isWriteEnabled()) throw Error("local_first_registration_unavailable");
    // A concurrent caller may have awaited the same authority read.
    const concurrent = entries.get(args.clientNonce);
    if (concurrent) {
      if (concurrent.declaration !== declaration) throw Error("local_first_request_conflict");
      return concurrent.promise;
    }
    if (entries.size >= 64) throw Error("local_first_receipt_capacity");
    const entry: Entry = { declaration, args, receipt: { version: 1, operationId: args.clientNonce, localAgentId: null,
      source: { ...source }, settled: false, stage: "local-factory", outcome: "unknown", request: null, firstResponse: null, binding: null } };
    entries.set(args.clientNonce, entry);
    entry.promise = context.run(entry, async () => {
      let created: { agent: Row; transcript: unknown[] } | undefined;
      try {
        created = await manager.createBackgroundAgent(profile, args.origin ?? "user", options);
        if (!isContinuityUuid(created?.agent?.id) || created.agent.isGroup === true) throw Error("local_first_factory_identity_invalid");
        entry.receipt.localAgentId = created.agent.id;
        entry.receipt.stage = "registration";
        const binding = await identity.ensureServerBacked(created.agent.id);
        if (binding?.kind === "server_backed" && text(binding.serverId))
          entry.receipt.binding = { serverId: binding.serverId, harness: harness(binding.harness) };
        const r = entry.receipt.firstResponse, b = entry.receipt.binding;
        if (!r || r.agentId !== created.agent.id || r.harness !== "box" || !b || b.harness !== "box" || r.serverId !== b.serverId) {
          entry.receipt.outcome = r ? "mismatch" : "unknown";
          return { ...created, grokboxCreation: entry.receipt };
        }
        entry.receipt.stage = "readback";
        const row = (await manager.listAgents()).find(row => row.id === created!.agent.id);
        if (!row || row.isGroup === true || row.harness !== "box") entry.receipt.outcome = "mismatch";
        else { entry.receipt.outcome = "registered"; created = { ...created, agent: row }; }
        return { ...created, grokboxCreation: entry.receipt };
      } catch (error) {
        // Preserve a known local identity even when registration or readback
        // fails. No deletion, relabeling, second mint or model start here.
        if (entry.receipt.localAgentId && created) return { ...created, grokboxCreation: entry.receipt };
        throw error;
      } finally { entry.receipt.settled = true; }
    });
    return entry.promise;
  }
  function mint(request: Row, forward: (request: Row) => Promise<unknown>): Promise<unknown> | undefined {
    const entry = context.getStore();
    if (!entry) return undefined;
    const receipt = entry.receipt;
    if (request.agentId !== receipt.localAgentId || request.createCaller !== "ensure-server-backed" || request.createIntent !== "register-existing-local"
      || receipt.request !== null) throw Error("local_first_registration_identity_or_replay");
    const fields = { agentId: request.agentId, harness: "box" as const, createCaller: "ensure-server-backed" as const,
      createIntent: "register-existing-local" as const, introductionSuppressed: entry.args.isIntroductionSuppressed ?? false,
      kickstartRequested: entry.args.isKickstartRequested ?? false };
    receipt.request = fields;
    // Bypass the registrar's generic retry wrapper for this single admitted
    // creation, retaining its original transport, codec and profile writer.
    return Promise.resolve().then(() => forward({ ...request, ...fields })).then(raw => {
      receipt.stage = "server-result";
      const row = object(raw) && object(raw.agent) ? raw.agent : null;
      receipt.firstResponse = { outcome: object(raw) ? text(raw.outcome) ?? "unrecognized" : "unrecognized",
        agentId: isContinuityUuid(row?.agentId) ? row!.agentId : null,
        serverId: text(row?.id), harness: harness(row?.harness) };
      return raw;
    });
  }
  return { create, mint, read, source: () => ({ ...source }) };
}
