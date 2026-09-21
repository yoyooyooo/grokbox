import { openBotHandover, replacementIsActivated, type BotHandoverPort, type HandoverEffect } from "./bot-handover.runtime.ts";
import { handoverPolicy, handoverItemId, discoverPeers, isContinuityUuid, botWorkflowDigest, CurrentStateFailure,
  type BotWorkflowRequest, type HandoverPlanItem } from "@grokbox/runtime-kernel/continuity";
import { parseAgentTitle, formatAgentTitle, inspectOwnership, decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { projectNativeRoutines, observedRoutineDefinitionDigest } from "@grokbox/runtime-kernel/routines";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { NativeContinuityContext, ContinuityGateway, ContinuityDiscovery } from "../io/continuity-gateway.node.ts";
import { openContinuityControls } from "./continuity-control.runtime.ts";

const done = (evidence: unknown, extra: Partial<HandoverEffect> = {}): HandoverEffect => ({ state: "complete", evidence: sha256Text(canonicalJson(evidence)), ...extra });
const unsupported = (detail: string): HandoverEffect => ({ state: "unsupported", detail });
/** Formal native effects behind the original per-duty CONT guards. A notice
 * can use the authenticated user only when that policy explicitly permits it;
 * no forged Bot sender, credential request or new scheduler is introduced. */
export function createNativeBotHandover(deps: NativeContinuityContext, scopeId: string, timeoutMs: number,
  authorized?: (request: BotWorkflowRequest) => Promise<boolean>) {
  const gateway = deps.gateway(), controls = openContinuityControls({ durableRoot: deps.boxRuntimeRoot, scopeId }); let generation: string | undefined;
  const check = <A>(response: { result: A; discovery: ContinuityDiscovery }): A => {
    const current = canonicalJson([response.discovery.baseUrl, response.discovery.pid, response.discovery.startedAt]);
    if (generation !== undefined && generation !== current) throw new CurrentStateFailure("source_changed");
    generation = current; return response.result;
  };
  const effect = async <A>(request: BotWorkflowRequest, run: () => Promise<A>): Promise<A> => {
    if (!await port.authorize(request)) throw new CurrentStateFailure("policy_changed");
    deps.signal?.throwIfAborted();
    return run();
  };
  const rpc = async (method: Parameters<ContinuityGateway["rpc"]>[0], body: Record<string, unknown>, write = false, request?: BotWorkflowRequest) => {
    const run = () => gateway.rpc(method, body, { timeoutMs, maxResponseBytes: 512 * 1024,
      ...(write ? { write: true, singleAttempt: true, unknownOutcomeCode: "operation_outcome_unknown" } : {}) });
    if (write && !request) throw new CurrentStateFailure("invalid_request");
    return check(await (write ? effect(request!, run) : run()));
  };
  const roster = async () => {
    const r = await gateway.listAgents(timeoutMs); const rows = check({ result: r.agents, discovery: r.discovery });
    if (!Array.isArray(rows) || rows.length > 4096) throw new CurrentStateFailure("material_invalid"); return rows as any[];
  };
  const exact = async (id: string) => {
    const found = (await roster()).filter(r => r.id === id);
    if (found.length !== 1) throw new CurrentStateFailure("source_changed"); return found[0];
  };
  const tail = async (id: string) => {
    const result = await rpc("getAgentTranscriptTail", { id, limit: 512 }) as any;
    if (!Array.isArray(result?.entries) || result.entries.length > 512) throw new CurrentStateFailure("material_invalid");
    return result;
  };
  const routines = async (id: string) => {
    const result = await rpc("getAgentAutomations", { id });
    return { raw: result as any[], catalog: projectNativeRoutines(id, result) };
  };
  const source = (request: BotWorkflowRequest) => { if (!request.sourceId || request.scopeId !== scopeId) throw new CurrentStateFailure("invalid_request"); return request.sourceId; };
  const observedTitle = async (id: string, value: string) => parseAgentTitle((await exact(id)).title).fields.extra.some(([k,v]) => k === "handoff" && v === value);
  const notice = (request: BotWorkflowRequest, item: HandoverPlanItem) => `交接通知 [grokbox-handoff:${item.itemId}]：${request.sourceId} 的相关职责已由新的 Box Bot ${String(item.input.targetId)} 接续。后续新任务请联系 ${String(item.input.targetId)}；原 Bot 仍处理尚未交接的结果。请勿重复派发已有任务。本消息由用户授权的交接程序发送。`;
  const noticeRecorded = async (request: BotWorkflowRequest, item: HandoverPlanItem) => {
    const entries = (await tail(String(item.input.destination))).entries, text = notice(request,item);
    return entries.some((e: any) => e?.kind === "message" && e.role === "user" && e.content === text);
  };
  const port: BotHandoverPort = {
    authorize: async request => {
      deps.signal?.throwIfAborted();
      if (request.management && !authorized || authorized && !await authorized(request)) return false;
      const id = source(request), saved = await controls.request(request.operationId), workflow = await controls.workflow(request.operationId);
      if (botWorkflowDigest(saved) !== botWorkflowDigest(request) || !replacementIsActivated(saved, workflow)) return false;
      const proof = check(await gateway.getAgentOwnership([id, workflow.targetId!], Math.min(timeoutMs,15000))) as any;
      const at = Date.parse(proof?.serverObservedAt ?? ""), target = decideManagedOwnership({ agentId: workflow.targetId!, snapshot: proof, nowMs: Date.now() });
      const sourceRows = Array.isArray(proof?.agents) ? proof.agents.filter((row: any) => row.agentId === id) : [];
      const valid = proof?.scope?.id === scopeId && proof.scope.stable === true && Number.isFinite(at) && Date.now() >= at && Date.now()-at <= 5000
        && target.ok && target.evidence.scopeId === scopeId && sourceRows.length === 1 && sourceRows[0].serverEvidence === "found" && sourceRows[0].server?.viewerIsOwner === true;
      deps.signal?.throwIfAborted();
      return valid && (!authorized || await authorized(request));
    },
    discover: async (request, targetId, knownIds) => {
      const old = source(request), policy = handoverPolicy(request.handover), known = new Set(knownIds), items: HandoverPlanItem[] = [];
      const add = (kind: HandoverPlanItem["kind"], key: string, data: Record<string,unknown>, dependsOn: string[] = []) => {
        const itemId = handoverItemId(request.operationId, kind, key);
        if (!known.has(itemId)) items.push({ itemId, kind, dependsOn, input: { ...data, targetId } }); return itemId;
      };
      if (policy.oldBotAssistance) add("old-guidance", old, { agentId: old });
      if (policy.titles) { add("title-old", old, { agentId: old }); add("title-new", targetId, { agentId: targetId }); }
      if (policy.sidebar) add("sidebar", old, { agentId: old });
      if (policy.groups) for (const group of await roster()) {
        if (group.isGroup !== true || !isContinuityUuid(group.id) || !Array.isArray(group.memberIds) || !group.memberIds.includes(old)) continue;
        const note = add("group-notice", group.id, { destination: group.id });
        add("group-members", group.id, { groupId: group.id, before: group.memberIds }, [note]);
      }
      if (policy.directMessages) {
        const view = await tail(old);
        for (const peerId of discoverPeers(view.entries, old, [targetId])) add("dm-notice", peerId, { destination: peerId });
      }
      if (policy.routines === "move") {
        const view = await routines(old);
        for (const routine of view.catalog.routines) {
          const raw = view.raw.find(r => r.id === routine.id);
          if (!raw || !routine.mutable || !["webhook","cron"].includes(routine.trigger.type)) {
            add("external-task", `routine:${routine.id}`, { reason: "routine_definition_unsupported", routineId: routine.id }); continue;
          }
          const create = add("routine-create", routine.id, { sourceRoutineId: routine.id, definitionRevision: routine.definitionRevision,
            blueprint: { schemaVersion: 1, key: `handoff_${sha256Text(request.operationId+routine.id).slice(0,24)}`, name: raw.name, prompt: raw.prompt, trigger: raw.trigger, isEnabled: false } });
          const stop = add("routine-stop", routine.id, { routineId: routine.id, definitionRevision: routine.definitionRevision }, [create]);
          const intent = request.routineIntent?.find(r => r.id === routine.id && r.definitionRevision === routine.definitionRevision);
          if (intent?.enabled ?? routine.enabled) add("routine-enable", routine.id, { sourceRoutineId: routine.id, createItem: create, stopItem: stop, sourceDefinitionRevision: routine.definitionRevision,
            targetDefinitionHash: observedRoutineDefinitionDigest({ name: raw.name, prompt: raw.prompt, trigger: raw.trigger, isEnabled: false }) }, [create,stop]);
        }
      }
      add("external-task", "external-dependency-inventory", { reason: "external_dependencies_require_verification" });
      return { items, coverage: "partial" };
    },
    inspect: async (request,item,completed) => {
      const policy = handoverPolicy(request.handover), old = source(request), targetId = String(item.input.targetId);
      if (item.kind === "external-task") return unsupported(String(item.input.reason));
      if (item.kind === "old-guidance") {
        const row = await exact(old);
        return String(row.description ?? "").includes(`[grokbox-handoff:${request.operationId}] successor=${targetId}`) ? done([old,targetId,"guidance"]) : { state:"not_dispatched" };
      }
      if (item.kind === "title-old" || item.kind === "title-new") return await observedTitle(String(item.input.agentId),item.kind === "title-old" ? "redirecting" : "active") ? done([item.itemId,"title"]) : { state:"not_dispatched" };
      if (item.kind === "sidebar") {
        const settings = await rpc("getHostSettings", {}) as any;
        if (!Array.isArray(settings?.sidebarSections)) return unsupported("sidebar_shape_unavailable");
        return settings.sidebarSections.some((s:any) => s.name === "替身交接期" && s.agentIds?.includes(old)) ? done([old,"sidebar"]) : {state:"not_dispatched"};
      }
      if (item.kind === "group-notice" || item.kind === "dm-notice") {
        if (!policy.allowUserMessages) return unsupported("user_message_authorization_required");
        return await noticeRecorded(request,item) ? done([item.itemId,"native_message_record"]) : {state:"not_dispatched"};
      }
      if (item.kind === "group-members") {
        const group = await exact(String(item.input.groupId));
        if (!Array.isArray(group.memberIds)) return unsupported("group_members_unavailable");
        return group.memberIds.includes(targetId) && !group.memberIds.includes(old) ? done([group.id,group.memberIds]) : {state:"not_dispatched"};
      }
      if (item.kind === "routine-create") {
        const outcome = (await gateway.routineProvision({action:"outcome",agentId:targetId,operationId:item.itemId},timeoutMs)).result as any;
        return outcome.state === "disabled_definition_observed" ? done([outcome.routineId,outcome.revision],{routineId:outcome.routineId,revision:outcome.revision}) : {state:"not_dispatched"};
      }
      if (item.kind === "routine-stop") {
        const row = (await routines(old)).catalog.routines.find(r => r.id === item.input.routineId);
        if (!row || row.definitionRevision !== item.input.definitionRevision) return unsupported("source_routine_changed_or_unobserved");
        return !row.enabled ? done([row.id,row.revision],{routineId:row.id,revision:row.revision}) : {state:"not_dispatched"};
      }
      if (item.kind === "routine-enable") {
        const created = completed.get(String(item.input.createItem));
        if (!created?.routineId) return unsupported("target_routine_unconfirmed");
        const view = await routines(targetId), row = view.catalog.routines.find(r => r.id === created.routineId), definition = view.raw.find(r => r.id === created.routineId);
        if (!definition || observedRoutineDefinitionDigest({name:definition.name,prompt:definition.prompt,trigger:definition.trigger,isEnabled:false}) !== item.input.targetDefinitionHash) return unsupported("target_routine_definition_changed");
        return row?.enabled ? done([row.id,row.revision],{routineId:row.id,revision:row.revision}) : {state:"not_dispatched"};
      }
      return unsupported("unsupported_item");
    },
    perform: async (request,item,completed) => {
      deps.signal?.throwIfAborted();
      const old = source(request), targetId = String(item.input.targetId), policy = handoverPolicy(request.handover);
      if (item.kind === "external-task") return unsupported(String(item.input.reason));
      if (item.kind === "old-guidance") {
        const row = await exact(old), marker = `[grokbox-handoff:${request.operationId}] successor=${targetId}`;
        const description = `${row.description ?? ""}\n\n${marker}\n你正在交接。已转移的职责请指向 ${targetId}，未结旧任务保留原任务ID并转交结果；不重复派发任务、不重复群发、不自行删除。未明确转交的工作先核实。`;
        if (description.length > 32768) return unsupported("profile_instruction_budget");
        await rpc("updateAgent", {id:old,profile:{name:row.name,description,title:row.title??"",avatarShape:row.avatarShape??"",avatarColor:row.avatarColor??""}},true,request);
      } else if (item.kind === "title-old" || item.kind === "title-new") {
        const id = String(item.input.agentId), row = await exact(id), parsed = parseAgentTitle(row.title);
        const proof = check(await gateway.getAgentOwnership([id],Math.min(timeoutMs,15000)));
        const classification = inspectOwnership({agentIds:[id],snapshot:proof}).agents[0]?.state;
        const owner = classification === "confirmed_box" ? "box" : classification === "confirmed_temporal" ? "temporal" : classification === "conflict" ? "conflict" : parsed.fields.owner;
        const fields = {...parsed.fields,owner,extra:[...parsed.fields.extra.filter(([k])=>k!=="handoff"&&k!=="next"),["handoff",item.kind==="title-old"?"redirecting":"active"] as const,
          ...(item.kind==="title-old"?[["next",targetId] as const]:[])]};
        if (owner !== "box") { delete fields.m; delete fields.e; }
        await rpc("updateAgent",{id,profile:{name:row.name,description:row.description??"",title:formatAgentTitle(parsed.user,fields),avatarShape:row.avatarShape??"",avatarColor:row.avatarColor??""}},true,request);
      } else if (item.kind === "sidebar") {
        const settings = await rpc("getHostSettings",{}) as any;
        if (!Array.isArray(settings?.sidebarSections) || settings.sidebarSections.length > 128) return unsupported("sidebar_shape_unavailable");
        const sections = settings.sidebarSections.map((s:any)=>({id:s.id,name:s.name,agentIds:s.agentIds,...(typeof s.isCollapsed==="boolean"?{isCollapsed:s.isCollapsed}:{})}));
        const section = sections.find((s:any)=>s.name==="替身交接期");
        if (section) await rpc("assignAgentToSidebarSection",{agentId:old,sectionId:section.id},true,request);
        else {
          const fresh = await rpc("getHostSettings",{}) as any;
          if (canonicalJson(fresh?.sidebarSections) !== canonicalJson(settings.sidebarSections)) return {state:"not_dispatched",detail:"sidebar_changed"};
          await rpc("setHostSettings",{sidebarSections:[...sections,{id:handoverItemId(request.operationId,"sidebar","section"),name:"替身交接期",agentIds:[old],isCollapsed:false}]},true,request);
        }
      } else if (item.kind === "group-notice" || item.kind === "dm-notice") {
        if (!policy.allowUserMessages) return unsupported("user_message_authorization_required");
        await rpc("sendPrompt",{agentId:item.input.destination,prompt:notice(request,item),clientNonce:item.itemId},true,request);
      } else if (item.kind === "group-members") {
        const group = await exact(String(item.input.groupId));
        if (!Array.isArray(group.memberIds) || canonicalJson(group.memberIds) !== canonicalJson(item.input.before)) return {state:"not_dispatched",detail:"group_members_changed"};
        await rpc("setGroupMembers",{id:group.id,memberAgentIds:[...new Set(group.memberIds.map((id:string)=>id===old?targetId:id))]},true,request);
      } else if (item.kind === "routine-create") {
        const output = (await effect(request, () => gateway.routineProvision({action:"apply",agentId:targetId,operationId:item.itemId,confirmed:true,blueprint:item.input.blueprint},timeoutMs))).result as any;
        return output.state === "disabled_definition_observed" ? done([output.routineId,output.revision],{routineId:output.routineId,revision:output.revision}) : {state:"unknown"};
      } else if (item.kind === "routine-stop") {
        const row = (await routines(old)).catalog.routines.find(r=>r.id===item.input.routineId);
        if (!row || row.definitionRevision !== item.input.definitionRevision) return {state:"not_dispatched",detail:"source_routine_changed"};
        if (row.enabled) await effect(request, () => gateway.agentRoutines({action:"disable",agentId:old,routineId:row.id,expectedRevision:row.revision,operationId:item.itemId,confirmed:true},timeoutMs));
      } else if (item.kind === "routine-enable") {
        const created = completed.get(String(item.input.createItem)); if (!created?.routineId) return unsupported("target_routine_unconfirmed");
        const row = (await routines(targetId)).catalog.routines.find(r=>r.id===created.routineId);
        if (!row || row.revision !== created.revision) return {state:"not_dispatched",detail:"target_routine_changed"};
        const currentSource = (await routines(old)).catalog.routines.find(r=>r.id===item.input.sourceRoutineId);
        if (!currentSource || currentSource.enabled || currentSource.definitionRevision !== item.input.sourceDefinitionRevision) return {state:"not_dispatched",detail:"source_routine_no_longer_stopped"};
        if (!row.enabled) await effect(request, () => gateway.agentRoutines({action:"enable",agentId:targetId,routineId:row.id,expectedRevision:row.revision,operationId:item.itemId,confirmed:true},timeoutMs));
      }
      const observed = await port.inspect(request,item,completed);
      return observed.state === "complete" ? observed : { state: "unknown" };
    },
  };
  return { program: openBotHandover({durableRoot:deps.boxRuntimeRoot,scopeId,native:port}), port, tail, routines, roster };
}
