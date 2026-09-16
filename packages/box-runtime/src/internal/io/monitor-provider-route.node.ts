import { randomUUID } from "node:crypto";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { failureSummaryFromObservation, projectStreamSummary, observationOwn as own } from "@grokbox/runtime-kernel/contract";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

/** Notification-only route policy. Neither an incident nor this projection may
 * change model admission, retries, ownership, or a historical STEP result. */
export const PROVIDER_ROUTE_POLICY = { version: "provider-route-v1", windowMs: 300_000, qualifyFailures: 2, recoverSuccesses: 2, sampleTarget: 512 } as const;
type Sample = { key: string; at: number; result: "ok" | "http_error"; status?: number };
export type ProviderRouteDiagnosis = { kind: "provider_route_condition"; policyVersion: "provider-route-v1"; routeId: string;
  state: "observing" | "degraded" | "recovered"; failures: number; successesAfterLastFailure: number;
  lastFailureAt: number; lastPositiveAt: number | null; sampleCount: number; coverage: "bounded_route_window" };
function sample(value: Record<string, unknown>): { routeId: string; value: Sample } | undefined {
  if (value.name !== "model_step_terminal") return;
  const failure = failureSummaryFromObservation(value), stream = projectStreamSummary(value.stream)
    ?? projectStreamSummary(own(value.diagnostic, "stream")) ?? failure?.diagnostic?.stream;
  const routeId = stream?.route?.id, at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
  if (!routeId || !Number.isSafeInteger(at) || at < 0) return;
  const identity = [value.hostGenerationId, value.serviceEpoch, value.agentId, value.turnId, value.stepId];
  if (identity.some(v => typeof v !== "string" || !v)) return;
  const key = sha256Text(canonicalJson(identity));
  if (value.outcome === "ok" && value.phase === "complete") return { routeId, value: { key, at, result: "ok" } };
  const status = failure?.http?.status;
  if (failure?.category === "upstream_http" && status !== undefined && status >= 500 && status <= 599) return { routeId, value: { key, at, result: "http_error", status } };
}
export function projectProviderRouteDiagnosis(value: unknown): ProviderRouteDiagnosis | null {
  try {
    const field = (key: string) => own(value, key), routeId = field("routeId"), state = field("state");
    if (field("kind") !== "provider_route_condition" || field("policyVersion") !== PROVIDER_ROUTE_POLICY.version || typeof routeId !== "string" || !/^[a-f0-9]{64}$/.test(routeId)
      || !["observing", "degraded", "recovered"].includes(String(state)) || field("coverage") !== "bounded_route_window") return null;
    for (const k of ["failures", "successesAfterLastFailure", "lastFailureAt", "sampleCount"]) if (!Number.isSafeInteger(field(k)) || Number(field(k)) < 0) return null;
    if (field("lastPositiveAt") !== null && (!Number.isSafeInteger(field("lastPositiveAt")) || Number(field("lastPositiveAt")) < 0)) return null;
    return { kind: "provider_route_condition", policyVersion: PROVIDER_ROUTE_POLICY.version, routeId,
      state: state as ProviderRouteDiagnosis["state"], failures: Number(field("failures")), successesAfterLastFailure: Number(field("successesAfterLastFailure")),
      lastFailureAt: Number(field("lastFailureAt")), lastPositiveAt: field("lastPositiveAt") === null ? null : Number(field("lastPositiveAt")), sampleCount: Number(field("sampleCount")), coverage: "bounded_route_window" };
  } catch { return null; }
}
export async function indexProviderRouteCondition(db: MonitorSqlite, input: {
  rootId: string; value: Record<string, unknown>; ref: string;
  opened: (id: string, agentId: string | null) => Promise<void>; recovered: (id: string) => Promise<void>;
}): Promise<void> {
  const current = sample(input.value); if (!current) return;
  const key = sha256Text(canonicalJson(["upstream-route", current.routeId]));
  const prior = await db.first("SELECT * FROM incidents WHERE scope=? AND rule='upstream_route_failure' AND occurrence_key=? ORDER BY first_seen DESC LIMIT 1", [input.rootId, key]);
  const linkCurrent = async (id: string) => {
    await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [id, input.ref]);
    if (current.value.result !== "http_error") return;
    const v = input.value, childKey = sha256Text(canonicalJson([v.hostGenerationId ?? null,v.agentId,v.turnId,v.stepId]));
    await db.run("UPDATE incidents SET parent_id=? WHERE scope=? AND agent_id=? AND rule='execution_failure' AND occurrence_key=? AND parent_id IS NULL", [id,input.rootId,String(v.agentId),childKey]);
  };
  // The newest condition may already be a different open cycle. A late
  // execution must still join the resolved cycle covering its source time.
  const historical = await db.first("SELECT id FROM incidents WHERE scope=? AND rule='upstream_route_failure' AND occurrence_key=? AND status='resolved' AND first_seen<=? AND resolved_at>=? ORDER BY first_seen DESC LIMIT 1",
    [input.rootId,key,current.value.at,current.value.at]);
  if (historical) { await linkCurrent(String(historical.id)); return; }
  if (prior?.status === "resolved" && current.value.at <= Number(prior.resolved_at)) return;
  const routeExpression = "COALESCE(json_extract(payload,'$.stream.route.id'),json_extract(payload,'$.diagnostic.stream.route.id'),json_extract(payload,'$.failureSummary.diagnostic.stream.route.id'))";
  const latest = await db.first(`SELECT MAX(at_ms) AS at FROM evidence WHERE ${routeExpression}=?`, [current.routeId]);
  const watermark = Math.max(current.value.at, Number(latest?.at ?? current.value.at));
  const cycleStart = prior?.status === "resolved" ? Number(prior.resolved_at) + 1 : 0;
  const rows = await db.all(`SELECT payload,ref FROM evidence WHERE ${routeExpression}=? AND at_ms>=? AND at_ms<=? ORDER BY at_ms DESC LIMIT ?`,
    [current.routeId, Math.max(cycleStart, watermark - PROVIDER_ROUTE_POLICY.windowMs), watermark, PROVIDER_ROUTE_POLICY.sampleTarget]);
  const samples = new Map<string, { sample: Sample; ref: string }>();
  for (const row of rows) {
    if (typeof row.payload !== "string") continue;
    let parsed: unknown; try { parsed = JSON.parse(row.payload); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const item = sample(parsed as Record<string, unknown>); if (item?.routeId !== current.routeId) continue;
    const existing = samples.get(item.value.key);
    // Conflicting same-execution observations never prove route recovery.
    if (existing && canonicalJson(existing.sample) !== canonicalJson(item.value)) return;
    samples.set(item.value.key, { sample: item.value, ref: String(row.ref) });
  }
  if (current.value.at >= Math.max(cycleStart, watermark - PROVIDER_ROUTE_POLICY.windowMs)) samples.set(current.value.key, { sample: current.value, ref: input.ref });
  const ordered = [...samples.values()].sort((a,b) => a.sample.at - b.sample.at || a.sample.key.localeCompare(b.sample.key));
  const failures = ordered.filter(r => r.sample.result === "http_error");
  let previous: ProviderRouteDiagnosis | null = null;
  if (prior?.status === "open" && typeof prior.summary_json === "string") { try { previous = projectProviderRouteDiagnosis(JSON.parse(prior.summary_json)); } catch { /* incomplete coverage cannot prove recovery */ } }
  if (!previous && failures.length < PROVIDER_ROUTE_POLICY.qualifyFailures) return;
  // Expiring source detail is NOT service recovery. Keep the condition's last
  // failure anchor until later positive end-to-end evidence closes it.
  const lastFailureAt = Math.max(previous?.lastFailureAt ?? 0, failures.at(-1)?.sample.at ?? 0);
  const positives = ordered.filter(r => r.sample.result === "ok" && r.sample.at > lastFailureAt);
  const recovered = positives.length >= PROVIDER_ROUTE_POLICY.recoverSuccesses;
  const diagnosis: ProviderRouteDiagnosis = { kind: "provider_route_condition", policyVersion: PROVIDER_ROUTE_POLICY.version, routeId: current.routeId,
    state: recovered ? "recovered" : "degraded", failures: Math.max(failures.length, previous?.failures ?? 0),
    successesAfterLastFailure: positives.length, lastFailureAt, lastPositiveAt: positives.at(-1)?.sample.at ?? null,
    sampleCount: ordered.length, coverage: "bounded_route_window" };
  const lastSeen = Math.max(watermark, Number(prior?.last_seen ?? 0));
  let id: string;
  if (!prior || prior.status === "resolved") {
    id = randomUUID();
    await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,resolved_at,revision,occurrence_key,category,summary_json) VALUES(?,?,NULL,'upstream_route_failure',?,?,?,?,1,?,'condition',?)",
      [id,input.rootId,recovered ? "resolved" : "open",failures[0]!.sample.at,lastSeen,recovered ? positives.at(-1)!.sample.at : null,key,canonicalJson(diagnosis)]);
    if (!recovered) await input.opened(id,null);
  } else {
    id = String(prior.id);
    await db.run("UPDATE incidents SET status=?,last_seen=?,resolved_at=?,revision=revision+1,summary_json=? WHERE id=?",
      [recovered ? "resolved" : "open",lastSeen,recovered ? positives.at(-1)!.sample.at : null,canonicalJson(diagnosis),id]);
    if (recovered && prior.status === "open") await input.recovered(id);
  }
  for (const row of ordered) await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)", [id,row.ref]);
  // Attach every observed failed child, not only the call which crossed the threshold.
  for (const row of failures) {
    const raw = await db.first("SELECT agent_id,step_id,host_generation,payload FROM evidence WHERE ref=?", [row.ref]);
    if (!raw || typeof raw.payload !== "string") continue;
    const v = JSON.parse(raw.payload), childKey = sha256Text(canonicalJson([v.hostGenerationId ?? null,v.agentId,v.turnId,v.stepId]));
    await db.run("UPDATE incidents SET parent_id=? WHERE scope=? AND agent_id=? AND rule='execution_failure' AND occurrence_key=? AND parent_id IS NULL", [id,input.rootId,String(v.agentId),childKey]);
  }
  await linkCurrent(id);
}
