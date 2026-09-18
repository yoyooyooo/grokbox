import { expect, test } from "bun:test";
import { allocateEvidenceAliases, publicEvidenceSummary, assessIncident, assessEvidenceCoverage,
  observationIncidentCandidate, type EvidenceFact, type IncidentEvidenceManifest } from "../src/observation.ts";

function facts(agent: string, step: string, privateText: string): EvidenceFact[] {
  return [{ ref: "input", value: { name: "host_seam_stage", agentId: agent, stepId: step, turnId: "private-turn", hostGenerationId: "private-generation", serviceEpoch: "private-epoch", stage: "hook_enter", prompt: privateText } },
    { ref: "failure", value: { name: "host_stream_rejected", agentId: agent, stepId: step, turnId: "private-turn", hostGenerationId: "private-generation", stage: "normalize", errorCode: "invalid_stream", diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", raw: privateText } } }];
}
function manifest(rows: EvidenceFact[], previous?: Record<string,string>): IncidentEvidenceManifest {
  return { schemaVersion: 1, incidentId: "private-incident", occurrenceId: "private-occurrence", evidenceRevision: 1, capturedAtMs: 1,
    classifierVersion: "incident-rules-v1", incidentRule: "execution_failure", sourceWindow: { source: "monitor", state: "observed", retainedFloor: 0, selected: rows.length, truncated: false, gapCodes: [] },
    factRefs: [], identityAliases: allocateEvidenceAliases(rows,previous), assessmentDigest: "private-digest", relationEdges: [],
    coverageByRequirement: assessEvidenceCoverage(rows), currentObservations: {status:"not_checked"}, viewPolicyVersion:"evidence-views-v1",
    retention: {tier:"detail",expiresAtMs:2,summaryExpiresAtMs:3},logicalBytes:0,digest:"private-digest" };
}
test("public structure is invariant under replacement of private IDs and business bodies",()=>{
  const a=facts("z-agent","z-step","PRIVATE_ONE"),b=facts("a-agent","a-step","PRIVATE_TWO");
  const left=publicEvidenceSummary(manifest(a),a,assessIncident("execution_failure",a));
  const right=publicEvidenceSummary(manifest(b),b,assessIncident("execution_failure",b));
  expect(right).toEqual(left);
  const text=JSON.stringify(left);
  for(const value of ["PRIVATE_ONE","PRIVATE_TWO","private-generation","private-epoch","private-turn","private-incident","private-digest","z-agent","z-step"])expect(text).not.toContain(value);
  expect(text).toContain("undeclared_tool");
  expect(left.facts[0]?.failure).toBeUndefined();
});
test("revision aliases extend rather than renumber; parent STEP references reuse the same alias",()=>{
  const a=facts("z-agent","z-step","x"),first=manifest(a);
  const more=[...a,{ref:"aux",value:{name:"model_step_terminal",agentId:"a-agent",stepId:"new-step",parentStepId:"z-step"}}];
  const second=manifest(more,first.identityAliases);
  expect(second.identityAliases["agentId:z-agent"]).toBe("agent-1");
  expect(second.identityAliases["agentId:a-agent"]).toBe("agent-2");
  expect(second.identityAliases["stepId:z-step"]).toBe("step-1");
  const view=publicEvidenceSummary(second,more,assessIncident("execution_failure",more));
  expect(view.facts[2]?.identities.parentStepId).toBe("step-1");
});
test("unknown fields and coercion hooks are never interpreted as event types or public messages",()=>{
  let calls=0;
  const trap={toString(){calls++;return "tray_created";}};
  const value={name:"host_alert_observation",kind:trap,hostGenerationId:"host",sourceInstanceId:"source",trayId:"tray",agentId:"agent"};
  expect(observationIncidentCandidate(value)).toBeUndefined();
  const row:EvidenceFact={ref:"safe",value:{name:trap,diagnostic:{get normalizeCause(){calls++;return "undeclared_tool";}},get prompt(){calls++;return "PRIVATE";}}};
  publicEvidenceSummary(manifest([row]),[row],assessIncident("native_alert",[row]));
  expect(calls).toBe(0);
});
test("Provider/SDK completeness needs actual request witnesses, not merely a diagnostic object",()=>{
  expect(assessEvidenceCoverage([{ref:"empty",value:{name:"model_step_terminal",diagnostic:{}}}]).find(row=>row.requirement==="E03")?.status).toBe("not_instrumented");
  const detail={normalizeCause:"undeclared_tool",rejectSite:"host_tool"};
  expect(assessEvidenceCoverage([{ref:"shape",value:{name:"model_step_terminal",diagnostic:detail}}]).find(row=>row.requirement==="E03")?.status).toBe("partial");
  const stream={counts:{providerFetchCalls:1,requestBytes:120,sdkParts:0},engine:{api:"chat",aiVersion:"5.0.253",providerVersion:"2.0.125",adapterRevision:4},http:{status:503}};
  expect(assessEvidenceCoverage([{ref:"witness",value:{name:"model_step_terminal",stream}}]).find(row=>row.requirement==="E03")?.status).toBe("observed");
  expect(assessEvidenceCoverage([{ref:"no-call",value:{name:"model_step_terminal",stream:{...stream,counts:{...stream.counts,providerFetchCalls:0}}}}]).find(row=>row.requirement==="E03")?.status).toBe("partial");
});
