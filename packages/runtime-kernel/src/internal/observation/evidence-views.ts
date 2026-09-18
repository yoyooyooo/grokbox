import { observationOwn as own } from "../contract/provider-observation.ts";
import { projectStreamDiagnostic } from "../contract/stream-diagnostic.ts";
import { failureSummaryFromObservation } from "../contract/failure-summary.ts";
import { evidenceIdentity, type EvidenceFact, type IncidentEvidenceManifest } from "./evidence-contract.ts";
import type { IncidentAssessment } from "./incident-rules.ts";
import { projectContinuityEvent } from "./continuity-contract.ts";

export const EVIDENCE_VIEW_POLICY = "evidence-views-v1";
export const PUBLIC_TOOL_CATALOG = Object.freeze({ SendToAgent: ["target_id", "message"], SendToUser: ["message"] } as const);
export type EvidenceView = "local-diagnostic" | "bot-diagnostic" | "public-summary";
const sourceNames = ["continuity_observation", "host_seam_stage", "host_stream_rejected", "host_normalized_terminal", "model_step_terminal", "host_run_observation", "host_alert_observation", "host_server_activity_observation", "host_context_observation", "host_tool_observation", "provider_error_observed", "observation_source_health"] as const;
const states = ["queued", "started", "finished", "failed", "cancelled", "reply_buffered", "member_returned", "checkpoint_started", "checkpoint_observed", "commit_unknown", "generated", "released", "native_started", "returned", "result_accepted"] as const;
const fields = ["agentId", "stepId", "turnId", "dispatchId", "failureId", "trayId", "hostGenerationId", "serviceEpoch", "sourceInstanceId", "clientNonce", "operationId", "dutyId", "occurrenceId", "scopeId", "rootId", "parentStepId"] as const;
const member = <T extends string>(value: unknown, values: readonly T[]) => typeof value === "string" && values.includes(value as T) ? value as T : undefined;
const uint = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** First-observed aliases are persisted in the private manifest and extend
 * across revisions. Changing real IDs does not change structural public facts. */
export function allocateEvidenceAliases(facts: readonly EvidenceFact[], previous: Readonly<Record<string,string>> = {}): Record<string,string> {
  const aliases: Record<string,string> = { ...previous };
  let bytes = Object.entries(aliases).reduce((n,[key,value])=>n+key.length+value.length+6,2);
  for (const field of fields) {
    const kind = field === "parentStepId" ? "stepId" : field;
    let count = Object.keys(aliases).filter(key => key.startsWith(`${kind}:`)).length;
    for (const value of new Set(facts.map(f => own(f.value, field)).filter(evidenceIdentity))) {
      const key = `${kind}:${value}`;
      if (!Object.hasOwn(aliases, key)) {
        const alias = `${kind.replace(/Id$/, "")}-${count + 1}`;
        if (bytes + key.length + alias.length + 6 > 64 * 1024) continue;
        aliases[key] = alias; count++; bytes += key.length + alias.length + 6;
      }
    }
  }
  return aliases;
}
export function publicEvidenceSummary(manifest: IncidentEvidenceManifest, facts: readonly EvidenceFact[], assessment: IncidentAssessment) {
  const aliases = new Map(Object.entries(manifest.identityAliases));
  const references = new Map(facts.map((f, i) => [f.ref, `fact-${i + 1}`]));
  return {
    schemaVersion: 1, view: "public-summary", policyVersion: EVIDENCE_VIEW_POLICY,
    evidenceRevision: manifest.evidenceRevision,
    assessment: { classifierVersion: assessment.classifierVersion, category: assessment.category, reason: assessment.reason,
      basis: assessment.basis, rootCause: assessment.rootCause, basisRefs: assessment.basisRefs.map(ref => references.get(ref)).filter(Boolean) },
    facts: facts.map(f => {
      const v = f.value, continuity = projectContinuityEvent(v);
      const failed = own(v, "name") === "host_stream_rejected" || (["model_step_terminal", "host_normalized_terminal"].includes(own(v, "name") as string)
        && ["error", "abort", "cancelled"].includes((own(v, "terminalClass") ?? own(v, "outcome")) as string));
      const summary = failed ? failureSummaryFromObservation(v) : undefined, diagnostic = projectStreamDiagnostic(own(v, "diagnostic"));
      const identities: Record<string, string> = {};
      for (const field of fields) { const value = own(v, field); if (evidenceIdentity(value)) identities[field] = aliases.get(`${field === "parentStepId" ? "stepId" : field}:${value}`)!; }
      const counts: Record<string, number> = {};
      for (const key of ["eventCount", "toolCallCount", "count", "waitMs", "elapsedMs"] as const) { const n = uint(own(v, key)); if (n !== undefined) counts[key] = n; }
      return { ref: references.get(f.ref), source: member(own(v, "name"), sourceNames) ?? "unknown_source", identities, counts,
        ...(continuity ? { continuity: { kind: continuity.kind, coverage: continuity.coverage.state,
          gapCodes: continuity.coverage.gapCodes, inboundCount: continuity.inboundCount, quietPeriodProven: false,
          recoveryReferences: "not_published", domainCompletion: "not_proven" } } : {}),
        ...(member(own(v, "state"), states) ? { state: member(own(v, "state"), states) } : {}),
        ...(summary ? { failure: { code: summary.code, phase: summary.phase, category: summary.category,
          ...(summary.http ? { httpStatus: summary.http.status } : {}) } } : {}),
        ...(diagnostic ? { diagnostic: {
          ...(diagnostic.normalizeCause ? { normalizeCause: diagnostic.normalizeCause } : {}),
          ...(diagnostic.rejectSite ? { rejectSite: diagnostic.rejectSite } : {}),
          ...(diagnostic.eventType ? { eventType: diagnostic.eventType } : {}),
          ...(diagnostic.declaredToolMatch !== undefined ? { declaredToolMatch: diagnostic.declaredToolMatch } : {}),
          ...(diagnostic.sdkValidation ? { sdkValidation: diagnostic.sdkValidation } : {}),
          ...(diagnostic.stream ? { stream: { counts: diagnostic.stream.counts, timings: diagnostic.stream.timings,
            ...(diagnostic.stream.toolIdentity ? { toolIdentity: { declaredCount: diagnostic.stream.toolIdentity.declared.count,
              ...(diagnostic.stream.toolIdentity.sent ? { sentCount: diagnostic.stream.toolIdentity.sent.count,
                matchesDeclared: diagnostic.stream.toolIdentity.sent.matchesDeclared } : {}),
              ...(diagnostic.stream.toolIdentity.firstMismatch ? { firstMismatch: { relation: diagnostic.stream.toolIdentity.firstMismatch.relation,
                layer: diagnostic.stream.toolIdentity.firstMismatch.layer } } : {}) } } : {}) } } : {}),
        } } : {}) };
    }),
    coverageByRequirement: manifest.coverageByRequirement.map(row => ({ ...row, sourceRefs: row.sourceRefs.map(ref => references.get(ref)).filter((x): x is string => !!x) })),
    redactionSummary: { rawContent: "not_collected", identities: "bounded_report_local_aliases", paths: "omitted", digests: "omitted", freeText: "omitted" },
    executionCompleted: "not_proven", replayAuthorized: false,
  };
}

export type EvidenceCommand = {
  commandId: "monitor-incident-v1" | "runtime-incident-v1" | "alerts-trace-v1";
  argv: string[];
  requires: "box-local";
  readOnly: true;
};
export type BotIncidentNotice = {
  schemaVersion: 1; kind: "grokbox.ops.notification"; intent: "brief-notice";
  incidentId: string; evidenceRevision: number; capturedAtMs: number;
  summary: string; classification: IncidentAssessment["category"];
  rootCause: "not_proven"; commands: EvidenceCommand[];
  evidence: { tier: "detail" | "summary"; expiresAtMs: number; missingRequirements: string[] };
  behavior: "notify_then_end";
  automaticDiagnosis: false; automaticIssue: false; replayAuthorized: false;
};
export function buildBotIncidentNotice(manifest: IncidentEvidenceManifest, assessment: IncidentAssessment): BotIncidentNotice {
  if (!evidenceIdentity(manifest.incidentId) || !Number.isSafeInteger(manifest.evidenceRevision) || manifest.evidenceRevision < 1) throw new Error("evidence_invalid_notice");
  const messages: Record<string, string> = {
    continuity_attention: "观察到受保护 Bot 的归属、恢复或未结操作异常；交接完成和安全退役须由业务证据另行判断。",
    native_alert: "观察到原生 Bot 告警，原因尚需结合现场判断。",
    native_run_failure: "观察到原生 Bot 任务失败；这不证明整个用户任务或所有子任务均已结束。",
    execution_stalled: "观察到任务长时间未收束的迹象；尚不能确认死锁。",
    source_gap: "部分观测来源不可用或存在缺口，不能据此判断业务已经恢复。",
    ownership_changed: "观察到 Bot 执行归属变化，请查看已保存的前后证据。",
    ownership_conflict: "观察到 Bot 归属信息不一致。",
    observation_unavailable: "当前无法取得完整观测证据。",
    execution_failure: "观察到运行失败，关键现场已保存；已有副作用是否完成需按证据判断。",
    pre_step_failure: "请求在建立完整 STEP 身份前被拒绝，现场保留了实际可用的关联信息。",
    shared_runtime_failure: "观察到本地运行时共享故障。",
    upstream_route_failure: "观察到上游模型路由失败条件。",
  };
  return { schemaVersion: 1, kind: "grokbox.ops.notification", intent: "brief-notice",
    incidentId: manifest.incidentId, evidenceRevision: manifest.evidenceRevision, capturedAtMs: manifest.capturedAtMs,
    summary: Object.hasOwn(messages, manifest.incidentRule) ? messages[manifest.incidentRule]! : "观察到尚未分类的异常，已有证据与缺口已保存。",
    classification: assessment.category, rootCause: "not_proven",
    commands: [{ commandId: "monitor-incident-v1", argv: ["grokbox", "runtime", "monitor", "incident", manifest.incidentId,
      "--evidence-revision", String(manifest.evidenceRevision), "--json"], requires: "box-local", readOnly: true }],
    evidence: { tier: "detail", expiresAtMs: manifest.retention.expiresAtMs,
      missingRequirements: manifest.coverageByRequirement.filter(r => r.status !== "observed").map(r => r.requirement) },
    behavior: "notify_then_end", automaticDiagnosis: false, automaticIssue: false, replayAuthorized: false };
}
