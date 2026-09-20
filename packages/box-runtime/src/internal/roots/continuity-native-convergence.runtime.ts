import { openBotConvergence, type BotConvergencePort } from "./bot-convergence.runtime.ts";
import { openContinuityControls } from "./continuity-control.runtime.ts";
import { CurrentStateFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createNativeBotHandover } from "./continuity-native-handover.runtime.ts";
import type { NativeContinuityContext } from "../io/continuity-gateway.node.ts";

export function createNativeBotConvergence(deps: NativeContinuityContext, scopeId: string, authorized?: (request: BotWorkflowRequest) => Promise<boolean>) {
  const gateway = deps.gateway(), controls = openContinuityControls({durableRoot:deps.boxRuntimeRoot,scopeId});
  const relations = createNativeBotHandover(deps,scopeId,30000,authorized);
  const native: BotConvergencePort = { authorize: relations.port.authorize,
    observe: async (request,targetId,previous) => {
      const at = Date.now(), view = await relations.tail(request.sourceId!), entries = view.entries as any[];
      const last = entries.at(-1)?.id, prior = typeof previous?.lastEntryId === "string" ? previous.lastEntryId : null;
      const index = prior === null ? -1 : entries.findIndex(e => e.id === prior);
      const contiguous = prior === null ? view.hasMore === false : index >= 0;
      const tail = prior === null ? entries : index >= 0 ? entries.slice(index+1) : entries;
      const newMessages = tail.filter(e => e.kind === "message" && e.role === "user" && !e.continuitySource
        && !(typeof e.content === "string" && e.content.includes("[grokbox-handoff:"))).length;
      const proof = (await gateway.getAgentOwnership([targetId],15000)).result;
      const target = decideManagedOwnership({agentId:targetId,snapshot:proof,nowMs:Date.now()});
      const items = await controls.items(request.operationId), external = items.filter(i => i.kind === "external-task");
      return { cursor: typeof last === "string" ? sha256Text(last) : null, observedAtMs: Math.max(at,Date.now()), newMessages, contiguous,
        state: { lastEntryId: typeof last === "string" ? last : prior, sourceWindowHash: sha256Text(canonicalJson(entries.map(e => [e.id,e.timestampMs]))), scope:"native_default_window" },
        targetUsable: target.ok && (proof as any)?.scope?.id === scopeId,
        dependenciesVerified: external.length > 0 && external.every(i => i.state === "complete"),
        // Quiet history is not proof that files/callbacks have no references to
        // the old Bot, and cannot invent an atomic ingress/deletion fence.
        resourcesIndependent: false, deletionFenceAvailable: false };
    },
    delete: async () => { throw new CurrentStateFailure("native_unavailable"); },
  };
  return { program: openBotConvergence({durableRoot:deps.boxRuntimeRoot,scopeId,native}), native };
}
