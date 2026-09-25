import { canonicalJson, sha256Text } from "../../portable-hash.ts";
const own = (value: unknown, field: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export type MaintenanceClassification = "related-same-shape" | "structural-change" | "unknown";
export type MaintenanceSource = { episodeId: string; classification: MaintenanceClassification; eventId: string };
export type MaintenanceSourceSelection = { state: "not_applicable" | "quiet" | "unavailable" } | { state: "ready"; source: MaintenanceSource };

/** Consume AH-188's producer decision. Never derive a classification from SHA,
 * a checker verdict, a missing window or an LLM. Older evidence stays older. */
export function maintenanceSource(facts: readonly unknown[]): MaintenanceSourceSelection {
  const candidates: MaintenanceSource[] = [];
  let present = false;
  for (const fact of facts) {
    const event = own(fact, "value"), change = own(event, "sourceChange");
    if (own(event, "name") !== "host_patch_health" || change === undefined) continue;
    present = true;
    if (own(event, "sourceState") === "snapshot") continue;
    const classification = own(change, "classification"), episodeId = own(change, "episodeId"), eventId = own(event, "eventId");
    if (own(change, "version") !== 1 || !hash(episodeId) || !uuid(eventId)
      || own(change, "executionAuthority") !== false || own(change, "userImpact") !== "not-established"
      || !["no-intersection", "related-same-shape", "structural-change", "unknown"].includes(String(classification))) return { state: "unavailable" };
    if (classification === "no-intersection") continue;
    candidates.push({ episodeId, classification: classification as MaintenanceClassification, eventId });
  }
  const identities = new Set(candidates.map(v => `${v.episodeId}:${v.classification}`));
  if (identities.size > 1) return { state: "unavailable" };
  const source = candidates.at(-1);
  return source ? { state: "ready", source } : { state: present ? "quiet" : "not_applicable" };
}
export type MaintenanceTask = { version: 1; kind: "grokbox.ops.analysis-task"; taskId: string; databaseId: string;
  incidentId: string; evidenceRevision: number; source: MaintenanceSource; expiresAtMs: number;
  requestedAction: "analyze"; mutationAuthority: false; adoptionAuthority: false; userImpact: "not-established";
  claimPath: "/v1/notification-task-claims"; reportPath: "/v1/notification-task-results"; digest: string };
export function maintenanceTask(input: { taskId: string; databaseId: string; incidentId: string; evidenceRevision: number;
  source: MaintenanceSource; expiresAtMs: number }): MaintenanceTask {
  if (!uuid(input.taskId) || !uuid(input.databaseId) || !uuid(input.incidentId) || !positive(input.evidenceRevision)
    || !positive(input.expiresAtMs) || !hash(input.source?.episodeId) || !uuid(input.source.eventId)
    || !["related-same-shape", "structural-change", "unknown"].includes(input.source.classification)) throw Error("notification_task_invalid");
  const body = { version: 1 as const, kind: "grokbox.ops.analysis-task" as const, taskId: input.taskId, databaseId: input.databaseId,
    incidentId: input.incidentId, evidenceRevision: input.evidenceRevision,
    source: { episodeId: input.source.episodeId, classification: input.source.classification, eventId: input.source.eventId },
    expiresAtMs: input.expiresAtMs, requestedAction: "analyze" as const, mutationAuthority: false as const, adoptionAuthority: false as const,
    userImpact: "not-established" as const, claimPath: "/v1/notification-task-claims" as const, reportPath: "/v1/notification-task-results" as const };
  return { ...body, digest: sha256Text(canonicalJson(body)) };
}
export function validateMaintenanceTask(value: MaintenanceTask): MaintenanceTask {
  const valid = maintenanceTask(value);
  if (canonicalJson(valid) !== canonicalJson(value)) throw Error("notification_task_invalid");
  return valid;
}
export type MaintenanceClaim = { requestId: string; claimId: string; principalId: string; claimedAtMs: number; taskDigest: string };
export type MaintenanceResult = { requestId: string; claimId: string; reportedAtMs: number;
  conclusion: "no-action-proposed" | "repair-proposed" | "inconclusive" | "blocked"; reportDigest: string | null };
export type MaintenanceReceipt = { source: "receiver-credential"; nativeTurnObserved: false;
  claim: MaintenanceClaim; result: MaintenanceResult | null };
export function validateMaintenanceReceipt(value: MaintenanceReceipt, task: MaintenanceTask): MaintenanceReceipt {
  const c = value?.claim, r = value?.result;
  if (value?.source !== "receiver-credential" || value.nativeTurnObserved !== false || !c || !uuid(c.requestId) || !uuid(c.claimId)
    || !positive(c.claimedAtMs) || c.claimedAtMs >= task.expiresAtMs || c.taskDigest !== task.digest
    || typeof c.principalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(c.principalId)
    || !(r === null || r && uuid(r.requestId) && r.claimId === c.claimId && positive(r.reportedAtMs) && r.reportedAtMs >= c.claimedAtMs
      && ["no-action-proposed", "repair-proposed", "inconclusive", "blocked"].includes(r.conclusion) && (r.reportDigest === null || hash(r.reportDigest))))
    throw Error("notification_task_receipt_invalid");
  const projected: MaintenanceReceipt = { source: "receiver-credential", nativeTurnObserved: false,
    claim: { requestId: c.requestId, claimId: c.claimId, principalId: c.principalId, claimedAtMs: c.claimedAtMs, taskDigest: c.taskDigest },
    result: r === null ? null : { requestId: r.requestId, claimId: r.claimId, reportedAtMs: r.reportedAtMs, conclusion: r.conclusion, reportDigest: r.reportDigest } };
  if (canonicalJson(value) !== canonicalJson(projected)) throw Error("notification_task_receipt_invalid");
  return projected;
}
export const maintenanceReceiverPrincipal = (bindingId: string): string => {
  if (!uuid(bindingId)) throw Error("notification_task_receiver_invalid");
  return `notification-receiver:${bindingId}`;
};
