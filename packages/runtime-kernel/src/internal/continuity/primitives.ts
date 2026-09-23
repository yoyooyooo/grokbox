export type ContinuityFailureCode = "invalid_material" | "scope_mismatch" | "not_initialized" | "schema_mismatch" | "unsafe_path"
  | "busy" | "capacity" | "conflict" | "unavailable" | "integrity_failure" | "commit_unknown" | "not_found" | "cancelled";
export class ContinuityFailure extends Error {
  constructor(readonly code: ContinuityFailureCode) { super(`continuity_${code}`); this.name = "ContinuityFailure"; }
}
export const failContinuity = (code: ContinuityFailureCode): never => { throw new ContinuityFailure(code); };
export const isContinuityUuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export const isContinuityHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
