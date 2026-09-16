/** Payload-free observations. A Tray, an execution failure and acknowledgement
 * are different facts. This module has no IO, execution or notification power. */
import { projectStreamDiagnostic } from "./internal/contract/stream-diagnostic.ts";
import { failureSummaryFromObservation, projectFailureSummary, presentFailure, FAILURE_CATEGORIES, type FailureCategory } from "./internal/contract/failure-summary.ts";
export { chooseNotification, projectNotification, NOTIFICATION_POLICY_VERSION } from "./notification-policy.ts";
export const ALERT_SCHEMA = 1;
export const ALERT_DIAGNOSIS_VERSION = "alert-chain-v1";
export const ALERT_CODES = ["parallel_tools", "invalid_stream", "model_error", "capacity", "ledger_unavailable", "invalid_envelope", "unsupported_image", "stream_limit", "not_admitted", "auth_mismatch", "provider_error", "cancelled", "unsupported_version"] as const;
export type AlertCode = typeof ALERT_CODES[number];
export const ALERT_REMOVALS = ["explicit_dismiss", "clear_all", "agent_clear", "new_input_cleanup", "evicted", "unknown"] as const;
export const ALERT_DECISIONS = ["emit", "merge", "suppress", "defer", "not_applicable"] as const;
export const ALERT_REASONS = ["native_error", "native_dedupe", "stale_run", "background_automation", "native_rate_limit", "unknown"] as const;
export type AlertObservationEvent = {
  name: "host_alert_observation"; schemaVersion: 1; eventId: string;
  sourceInstanceId: string; sourceSequence: number; hostGenerationId: string;
  at: string; observedAt: string;
  kind: "observer_started" | "manager_attached" | "decision" | "tray_created" | "tray_updated" | "tray_removed" | "channel_published" | "tray_snapshot";
  agentId?: string; trayId?: string; trayRevision?: number; count?: number;
  nativeRequestId?: string; stepId?: string; turnId?: string; clientNonce?: string; failureId?: string; decisionId?: string;
  observerRole?: "host_target" | "test";
  failureCategory?: FailureCategory;
  httpStatus?: number;
  presentationVersion?: "failure-facts-v1";
  classification?: AlertCode; classificationEvidence?: "direct" | "legacy_text_derived" | "unclassified";
  stepEvidence?: "direct" | "legacy_text_derived";
  decision?: typeof ALERT_DECISIONS[number]; reason?: typeof ALERT_REASONS[number];
  removalReason?: typeof ALERT_REMOVALS[number]; relatedEventId?: string;
  ruleVersion?: "native-host-v1"; actor?: "unknown";
  nativeSourceSha256?: string; preloadSha256?: string;
  decisionBasis?: "native_branch" | "mutation_observed";
  publicationBoundary?: "native_emitter_returned";
  capture?: { manager: boolean; mainDecision: boolean; automationDecision: boolean; inputCleanup: boolean };
};
export function observationId(v: unknown): v is string { return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v); }
export function own(v: unknown, key: PropertyKey): unknown {
  if (v === null || typeof v !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(v, key); return d && "value" in d ? d.value : undefined;
}
const member = <T extends string>(v: unknown, list: readonly T[]): T | undefined => typeof v === "string" && list.includes(v as T) ? v as T : undefined;
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
export function safeAlertCode(v: unknown): AlertCode | undefined { return v === "stream_invalid" ? "invalid_stream" : member(v, ALERT_CODES); }
export function classifyAlert(v: unknown): { code?: AlertCode; evidence: "direct" | "legacy_text_derived" | "unclassified"; stepId?: string; stepEvidence?: "direct" | "legacy_text_derived" } {
  const explicit = safeAlertCode(own(v,"managedCode")) ?? safeAlertCode(own(v,"code")) ?? safeAlertCode(own(v,"errorCode")) ?? safeAlertCode(own(v,"errorKind"));
  const text = [own(v,"detail"),own(v,"rawDetail")].filter((v): v is string => typeof v === "string").map(v=>v.slice(0,16384)).join("\n");
  const legacy = text.includes("Parallel tool calls are not supported. Rejected calls were not executed.") ? "parallel_tools"
    : text.includes("The model returned an invalid stream. The request was stopped without retry.") ? "invalid_stream" : undefined;
  const rawStep = own(v,"stepId"), parsed = text.match(/\binvocationId=([A-Za-z0-9_-]{1,128})(?:[)\s]|$)/)?.[1];
  return { ...(explicit ?? legacy ? { code: explicit ?? legacy } : {}), evidence: member(own(v,"classificationEvidence"),["direct","legacy_text_derived","unclassified"]) ?? (explicit ? "direct" : legacy ? "legacy_text_derived" : "unclassified"),
    ...(observationId(rawStep) ? { stepId: rawStep, stepEvidence: member(own(v,"stepEvidence"),["direct","legacy_text_derived"]) ?? "direct" } : parsed ? { stepId: parsed, stepEvidence: "legacy_text_derived" } : {}) };
}
export function projectAlertEvent(v: unknown): AlertObservationEvent | null {
  try {
    if (own(v,"name") !== "host_alert_observation" || own(v,"schemaVersion") !== 1) return null;
    const kind = member(own(v,"kind"),["observer_started","manager_attached","decision","tray_created","tray_updated","tray_removed","channel_published","tray_snapshot"]);
    const at=own(v,"at"), observedAt=own(v,"observedAt"), sequence=own(v,"sourceSequence");
    if (!kind || !instant(at) || !instant(observedAt) || !uint(sequence)) return null;
    const out: Record<string, unknown> = { name:"host_alert_observation", schemaVersion:1, kind, at, observedAt, sourceSequence:sequence };
    for (const key of ["eventId","sourceInstanceId","hostGenerationId"]) { const value=own(v,key); if(!observationId(value)) return null; out[key]=value; }
    for (const key of ["agentId","trayId","nativeRequestId","stepId","turnId","clientNonce","failureId","decisionId","relatedEventId"]) { const value=own(v,key); if(observationId(value))out[key]=value; }
    for (const key of ["count","trayRevision"]) { const n=own(v,key);if(uint(n))out[key]=n; }
    const classification=safeAlertCode(own(v,"classification")), classificationEvidence=member(own(v,"classificationEvidence"),["direct","legacy_text_derived","unclassified"]);
    if(classification)out.classification=classification;if(classificationEvidence)out.classificationEvidence=classificationEvidence;
    const role = member(own(v,"observerRole"), ["host_target", "test"]); if (role) out.observerRole = role;
    const category = member(own(v,"failureCategory"), FAILURE_CATEGORIES); if (category) out.failureCategory = category;
    const httpStatus = own(v,"httpStatus"); if (uint(httpStatus) && httpStatus >= 100 && httpStatus <= 599) out.httpStatus = httpStatus;
    if (own(v,"presentationVersion") === "failure-facts-v1") out.presentationVersion = "failure-facts-v1";
    const stepEvidence=member(own(v,"stepEvidence"),["direct","legacy_text_derived"]);if(stepEvidence)out.stepEvidence=stepEvidence;
    const decision=member(own(v,"decision"),ALERT_DECISIONS), reason=member(own(v,"reason"),ALERT_REASONS), removal=member(own(v,"removalReason"),ALERT_REMOVALS);
    if(decision)out.decision=decision;if(reason)out.reason=reason;if(removal)out.removalReason=removal;
    if(own(v,"ruleVersion")==="native-host-v1")out.ruleVersion="native-host-v1";
    if(own(v,"actor")==="unknown")out.actor="unknown";
    for(const field of ["nativeSourceSha256","preloadSha256"]){const digest=own(v,field);if(typeof digest==="string"&&/^[a-f0-9]{64}$/.test(digest))out[field]=digest;}
    const basis=member(own(v,"decisionBasis"),["native_branch","mutation_observed"]);if(basis)out.decisionBasis=basis;
    if(own(v,"publicationBoundary")==="native_emitter_returned")out.publicationBoundary="native_emitter_returned";
    const capture=own(v,"capture"), captured:Record<string,boolean>={};
    for(const key of ["manager","mainDecision","automationDecision","inputCleanup"]){const value=own(capture,key);if(typeof value==="boolean")captured[key]=value;}
    if(Object.keys(captured).length===4)out.capture=captured;
    if(kind==="decision" && (!decision || !reason || !out.decisionId))return null;
    if(kind.startsWith("tray_") && !out.trayId)return null;
    if(kind==="tray_removed" && !removal)return null;
    if(kind==="channel_published" && !out.relatedEventId)return null;
    return out as AlertObservationEvent;
  } catch { return null; }
}
export type ExecutionSelector = { agentId: string; stepId: string; hostGenerationId?: string };
export function sameExecution(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ["agentId","turnId","stepId"].every(k=>observationId(a[k]) && a[k]===b[k])
    && ["hostGenerationId","serviceEpoch"].every(k=>a[k]===undefined || (observationId(a[k]) && a[k]===b[k]));
}
export function selectExecutionFailure(events: readonly Record<string, unknown>[], selector?: ExecutionSelector) {
  const rows=[...events].reverse().filter(e=>!selector || (e.agentId===selector.agentId && e.stepId===selector.stepId && (!selector.hostGenerationId || e.hostGenerationId===selector.hostGenerationId)));
  return rows.find(e=>e.name==="host_stream_rejected") ?? rows.find(e=>e.name==="host_normalized_terminal" && ["error","abort"].includes(String(e.terminalClass)))
    ?? rows.find(e=>e.name==="model_step_terminal" && ["error","cancelled"].includes(String(e.outcome)));
}
export function specializeExecutionFailure(failure: Record<string, unknown>, events: readonly Record<string, unknown>[]) {
  if (!["host_stream_rejected", "host_normalized_terminal"].includes(String(failure.name))) return failure;
  if (failure.errorCode && failure.errorCode !== "model_error") return failure;
  const modeld = events.find(event => event.name === "model_step_terminal" && sameExecution(failure, event)
    && ["error", "cancelled"].includes(String(event.outcome)));
  if (modeld?.failureCode === "not_admitted") return { ...failure, reportedCode: failure.errorCode, reportedStage: failure.stage, errorCode: "not_admitted", reason: "authority-rejected", stage: "authority" };
  if (modeld?.failureCode === "stream_invalid") return { ...failure, errorCode: "invalid_stream", reason: "invalid-stream", stage: "normalize" };
  if (modeld?.phase === "admission" && ["capacity", "ledger_unavailable"].includes(String(modeld.failureCode))) {
    return { ...failure, reportedCode: failure.errorCode, reportedStage: failure.stage, errorCode: modeld.failureCode,
      reason: modeld.failureCode === "capacity" ? "local-capacity" : "execution-history-unavailable", stage: "admit" };
  }
  return failure;
}
export function diagnoseExecution(events: readonly Record<string, unknown>[], selector: ExecutionSelector) {
  const rows=events.filter(e=>e.agentId===selector.agentId && e.stepId===selector.stepId && (!selector.hostGenerationId || e.hostGenerationId===selector.hostGenerationId));
  const generations=new Set(rows.map(e=>e.hostGenerationId).filter(observationId));
  if(generations.size>1)return { state:"unknown", reason:"ambiguous_generation", classifierVersion:ALERT_DIAGNOSIS_VERSION };
  const turns=new Set(rows.map(e=>e.turnId).filter(observationId));
  const epochs=new Set(rows.map(e=>e.serviceEpoch).filter(observationId));
  if(turns.size>1||epochs.size>1)return {state:"unknown",reason:"ambiguous_execution",classifierVersion:ALERT_DIAGNOSIS_VERSION};
  const selected=selectExecutionFailure(rows),failure=selected?specializeExecutionFailure(selected,rows):undefined;
  const backend=rows.find(e=>e.name==="model_step_terminal" && (!failure || sameExecution(failure,e)));
  const hostDetail=projectStreamDiagnostic(failure?.diagnostic),backendDetail=projectStreamDiagnostic(backend?.diagnostic);
  const diagnostic=hostDetail?.normalizeCause?hostDetail:backendDetail??hostDetail;
  const failureSummary = hostDetail?.normalizeCause ? failureSummaryFromObservation(failure)
    : failureSummaryFromObservation(backend) ?? failureSummaryFromObservation(failure);
  return { state:failure ? "failure_observed" : "not_proven", classifierVersion:ALERT_DIAGNOSIS_VERSION,
    ...(failure ? { code:safeAlertCode(failure.errorCode ?? failure.failureCode) ?? "other", source:failure.name,
      stage:failure.stage ?? failure.phase ?? null, ...(diagnostic?{diagnostic}:{}),
      ...(failureSummary ? { failureSummary, category: failureSummary.category, presentation: presentFailure(failureSummary) } : {}), backend:backend ? { outcome:backend.outcome, phase:backend.phase, failureCode:backend.failureCode ?? null }:null } : {}) };
}
export type AlertTraceSelector = { trayId?: string; agentId?: string; stepId?: string; clientNonce?: string; sourceInstanceId?: string; hostGenerationId?: string; includeUnrelatedObservers?: boolean };
/** Only explicit links can connect an execution and presentation. No time/name
 * heuristic. Ambiguous instances remain separate; this does not create alerts. */
export function traceAlerts(raw: readonly unknown[], selector: AlertTraceSelector, coverage: { complete: boolean; source?: string; conflictingSources?: readonly string[] } = {complete:false}) {
  const records=raw.filter((x):x is Record<string,unknown>=>x!==null && typeof x==="object" && !Array.isArray(x));
  const projected=records.map(projectAlertEvent).filter((x):x is AlertObservationEvent=>x!==null);
  const byId=new Map<string,AlertObservationEvent>(),bySequence=new Map<string,string>(),conflicts=new Set<string>(coverage.conflictingSources ?? []);
  for(const e of projected){const key=`${e.sourceInstanceId}:${e.eventId}`,seqKey=`${e.sourceInstanceId}:${e.sourceSequence}`,text=JSON.stringify(e),prior=byId.get(key);
    if((prior&&JSON.stringify(prior)!==text)||(bySequence.has(seqKey)&&bySequence.get(seqKey)!==text))conflicts.add(e.sourceInstanceId);
    // Deterministic representative for conflicted evidence; integrity below
    // prevents it from being treated as an authoritative lifecycle state.
    if(!prior || text < JSON.stringify(prior))byId.set(key,e);bySequence.set(seqKey,text);
  }
  const events=[...byId.values()];
  const scope=events.filter(e=>(!selector.sourceInstanceId||e.sourceInstanceId===selector.sourceInstanceId)&&(!selector.hostGenerationId||e.hostGenerationId===selector.hostGenerationId));
  const seeds=scope.filter(e=>(!selector.agentId||e.agentId===selector.agentId)&&(!selector.trayId||e.trayId===selector.trayId)
    &&(!selector.stepId||e.stepId===selector.stepId)&&(!selector.clientNonce||e.clientNonce===selector.clientNonce));
  const trayKeys=new Set(seeds.filter(e=>e.trayId).map(e=>`${e.sourceInstanceId}:${e.trayId}`));
  const decisionKeys=new Set(seeds.filter(e=>e.decisionId).map(e=>`${e.sourceInstanceId}:${e.decisionId}`));
  // Resolve a decision-only STEP seed to its Tray using the explicit decision id.
  for(const e of scope)if(e.decisionId&&decisionKeys.has(`${e.sourceInstanceId}:${e.decisionId}`)&&e.trayId)trayKeys.add(`${e.sourceInstanceId}:${e.trayId}`);
  const linked=scope.filter(e=>seeds.includes(e)||(e.trayId&&trayKeys.has(`${e.sourceInstanceId}:${e.trayId}`))||(e.decisionId&&decisionKeys.has(`${e.sourceInstanceId}:${e.decisionId}`)));
  for(const e of linked)if(e.decisionId)decisionKeys.add(`${e.sourceInstanceId}:${e.decisionId}`);
  for(const e of scope)if(e.decisionId&&decisionKeys.has(`${e.sourceInstanceId}:${e.decisionId}`)&&!linked.includes(e))linked.push(e);
  const bySource=new Map<string,AlertObservationEvent[]>();for(const e of linked){const list=bySource.get(e.sourceInstanceId)??[];list.push(e);bySource.set(e.sourceInstanceId,list);}
  const traces=[...bySource].map(([sourceInstanceId,sourceEvents])=>{
    sourceEvents.sort((a,b)=>a.sourceSequence-b.sourceSequence);
    const trays=[...new Set(sourceEvents.map(e=>e.trayId).filter(observationId))].map(trayId=>{
      const list=sourceEvents.filter(e=>e.trayId===trayId), mutation=[...list].reverse().find(e=>["tray_created","tray_updated","tray_removed","tray_snapshot"].includes(e.kind));
      const steps=[...new Set(list.filter(e=>e.stepEvidence==="direct").map(e=>e.stepId).filter(observationId))];
      return {trayId, hostState:conflicts.has(sourceInstanceId)?"unknown_integrity":mutation?.kind==="tray_removed"?"removed_observed":mutation?"present_at_last_observation":"not_observed", removalReason:conflicts.has(sourceInstanceId)?null:mutation?.removalReason??null,
        count:mutation?.count??null, classification:mutation?.classification??null, classificationEvidence:mutation?.classificationEvidence??"unclassified",
        published:list.some(e=>e.kind==="channel_published"), appReceived:"not_observed", appRendered:"not_observed", userRead:"not_proven",
        executions:conflicts.has(sourceInstanceId)?[]:steps.map(stepId=>diagnoseExecution(records,{agentId:mutation?.agentId??selector.agentId??"",stepId,hostGenerationId:mutation?.hostGenerationId}))};
    });
    return {sourceInstanceId,integrity:conflicts.has(sourceInstanceId)?"conflict":"no_conflict_observed",hostGenerationId:sourceEvents[0]?.hostGenerationId,trays,decisions:sourceEvents.filter(e=>e.kind==="decision"),events:sourceEvents};
  });
  const generations=new Set([...linked.map(e=>e.hostGenerationId),...records.filter(e=>e.agentId===selector.agentId&&(!selector.stepId||e.stepId===selector.stepId)).map(e=>e.hostGenerationId).filter(observationId)]);
  const observers=new Map<string,AlertObservationEvent[]>();
  for(const event of events)if(generations.has(event.hostGenerationId)){const list=observers.get(event.sourceInstanceId)??[];list.push(event);observers.set(event.sourceInstanceId,list);}
  const allObservers = [...observers];
  const relatedSources = new Set(linked.map(e => e.sourceInstanceId));
  let relevantObservers = selector.includeUnrelatedObservers ? allObservers : allObservers.filter(([id, items]) =>
    relatedSources.has(id) || (!relatedSources.size && items.some(e => e.kind === "manager_attached")));
  if (!selector.includeUnrelatedObservers && relevantObservers.length === 0) {
    // Keep one real coverage witness per generation when no manager attached.
    // This is a coverage sample, not a fabricated execution/Tray relationship.
    const sampled = new Map<string, typeof allObservers[number]>();
    for (const row of allObservers) { const generation = row[1][0]?.hostGenerationId; if (generation) sampled.set(generation,row); }
    relevantObservers = [...sampled.values()];
  }
  const instrumentation=relevantObservers.map(([sourceInstanceId,items])=>{
    const latest=[...items].sort((a,b)=>b.sourceSequence-a.sourceSequence)[0]!;
    return {sourceInstanceId,hostGenerationId:latest.hostGenerationId,observerRole:latest.observerRole??"not_observed",capture:latest.capture??null,
      managerAttached:items.some(e=>e.kind==="manager_attached")?"observed":"not_observed",nativeSourceSha256:latest.nativeSourceSha256??null,
      preloadSha256:latest.preloadSha256??null,currentLiveness:"not_proven"};
  });
  return {classifierVersion:ALERT_DIAGNOSIS_VERSION, query:selector, traces, instrumentation,
    observerCoverage: { total: allObservers.length, shown: relevantObservers.length,
      omittedUnrelated: allObservers.length - relevantObservers.length, scope: selector.includeUnrelatedObservers ? "all_same_generation" : "linked_or_attached" }, ambiguous:!!selector.trayId&&traces.length>1,
    evidence:{source:coverage.source??"journal", completeness:coverage.complete?"complete_read_window":"partial_read_window", matchingEvents:linked.length,
      matching:linked.length?"observed":"not_observed_in_window", lifecycleCompleteness:"not_proven", currentLiveness:"not_proven"}, replayAuthorized:false};
}
