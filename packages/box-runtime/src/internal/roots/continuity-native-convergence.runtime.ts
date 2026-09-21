import { openBotConvergence, type BotConvergencePort } from "./bot-convergence.runtime.ts";
import { openContinuityControls } from "./continuity-control.runtime.ts";
import { CurrentStateFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createNativeBotHandover } from "./continuity-native-handover.runtime.ts";
import type { NativeContinuityContext } from "../io/continuity-gateway.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

export function createNativeBotConvergence(deps: NativeContinuityContext, scopeId: string, authorized?: (request: BotWorkflowRequest) => Promise<boolean>, hooks: ContinuityStoreHooks = {}) {
  const gateway = deps.gateway(), controls = openContinuityControls({durableRoot:deps.boxRuntimeRoot,scopeId});
  const relations = createNativeBotHandover(deps,scopeId,30000,authorized);
  const native: BotConvergencePort = { authorize: relations.port.authorize,
    observe: async (request,targetId,previous) => {
      const at = Date.now(), view = await relations.tail(request.sourceId!), entries = view.entries as any[];
      if(entries.some(e=>!e||typeof e.id!=="string"||!e.id||e.id.length>256||!Number.isSafeInteger(e.timestampMs)||e.timestampMs<0)
        ||new Set(entries.map(e=>e.id)).size!==entries.length||entries.some((e,i)=>i>0&&e.timestampMs<entries[i-1].timestampMs))throw new CurrentStateFailure("material_invalid");
      const last = entries.at(-1)?.id, prior = typeof previous?.lastEntryId === "string" ? previous.lastEntryId : null;
      const index = prior === null ? -1 : entries.findIndex(e => e.id === prior);
      const contiguous = prior === null ? view.hasMore === false : index >= 0 && previous?.lastEntryHash === sha256Text(canonicalJson(entries[index]));
      const tail = prior === null ? entries : index >= 0 ? entries.slice(index+1) : entries;
      // Message text is not origin authority. A user quoting a handoff marker
      // still creates real inbound activity; never turn it into quiet time.
      const newMessages = tail.filter(e => e.kind === "message" && e.role === "user").length;
      const proof = (await gateway.getAgentOwnership([targetId],15000)).result;
      const target = decideManagedOwnership({agentId:targetId,snapshot:proof,nowMs:Date.now()});
      const items = await controls.items(request.operationId), external = items.filter(i => i.kind === "external-task");
      return { cursor: typeof last === "string" ? sha256Text(last) : null, observedAtMs: Math.max(at,Date.now()), newMessages, contiguous,
        state: { lastEntryId: typeof last === "string" ? last : prior, lastEntryHash: entries.length?sha256Text(canonicalJson(entries.at(-1))):previous?.lastEntryHash??null, sourceWindowHash: sha256Text(canonicalJson(entries.map(e => [e.id,e.timestampMs]))), scope:"native_default_window" },
        targetUsable: target.ok && (proof as any)?.scope?.id === scopeId,
        dependenciesVerified: external.length > 0 && external.every(i => i.state === "complete"),
        // Quiet history is not proof that files/callbacks have no references to
        // the old Bot, and cannot invent an atomic ingress/deletion fence.
        resourcesIndependent: false, deletionFenceAvailable: false };
    },
    delete: async () => { throw new CurrentStateFailure("native_unavailable"); },
  };
  return { program: openBotConvergence({durableRoot:deps.boxRuntimeRoot,scopeId,native},hooks), native };
}
