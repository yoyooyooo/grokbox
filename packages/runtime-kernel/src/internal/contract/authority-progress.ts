import { AUTHORITY_CHECKPOINTS, AUTHORITY_REASONS, projectStreamDiagnostic, type AuthorityDiagnostic } from "./stream-diagnostic.ts";
import { observationOwn } from "./provider-observation.ts";
import { projectAuthorityPolicyId, type AuthorityPolicyId } from "./ownership-observation.ts";

/** Control-plane progress, never a model event, permission, or delivery receipt. */
export type AuthorityProgress = {
  version: 1;
  policyId: AuthorityPolicyId;
  phase: "waiting" | "authorized" | "denied" | "cancelled";
  checkpoint: typeof AUTHORITY_CHECKPOINTS[number];
  check: number;
  elapsedMs: number;
  cumulativeMs: number;
  remainingMs: number;
  retries: number;
  reason?: typeof AUTHORITY_REASONS[number];
  evidenceId?: string;
  diagnostic?: AuthorityDiagnostic;
};
/** Payload-free journal event. Identity is attached by the modeld root, not by
 * a remote source, a provider or a status consumer. */
export function projectModelAuthorityProgress(value: unknown): Record<string, unknown> | null {
  try {
    const own = (k: string) => observationOwn(value, k);
    const at = own("at"), authority = projectAuthorityProgress(own("authority"));
    if (own("name") !== "model_authority_progress" || own("schemaVersion") !== 1 || !authority
      || typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at))) return null;
    const result: Record<string, unknown> = { name: "model_authority_progress", schemaVersion: 1, at, authority };
    for (const key of ["agentId", "turnId", "stepId", "hostGenerationId", "serviceEpoch"] as const) {
      const id = own(key);
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)) return null;
      result[key] = id;
    }
    return result;
  } catch { return null; }
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_073_741_824;
const member = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === "string" && values.includes(v as T);
export function projectAuthorityProgress(value: unknown): AuthorityProgress | undefined {
  try {
    const get = (key: string) => observationOwn(value, key);
    const phase = get("phase"), checkpoint = get("checkpoint");
    const policyId = projectAuthorityPolicyId(get("policyId"));
    if (get("version") !== 1 || !policyId
      || !member(phase, ["waiting", "authorized", "denied", "cancelled"] as const)
      || !member(checkpoint, AUTHORITY_CHECKPOINTS)) return undefined;
    const check = get("check"), elapsedMs = get("elapsedMs"), cumulativeMs = get("cumulativeMs"), remainingMs = get("remainingMs"), retries = get("retries");
    if (!integer(check) || check < 1 || !integer(elapsedMs) || !integer(cumulativeMs) || !integer(remainingMs) || !integer(retries) || retries > 2) return undefined;
    const result: AuthorityProgress = { version: 1, policyId, phase, checkpoint, check, elapsedMs, cumulativeMs, remainingMs, retries };
    const reason = get("reason");
    if (member(reason, AUTHORITY_REASONS)) result.reason = reason;
    const evidenceId = get("evidenceId");
    if (typeof evidenceId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(evidenceId)) result.evidenceId = evidenceId;
    const diagnostic = projectStreamDiagnostic({ authority: get("diagnostic") })?.authority;
    if (diagnostic) result.diagnostic = diagnostic;
    return result;
  } catch { return undefined; }
}
