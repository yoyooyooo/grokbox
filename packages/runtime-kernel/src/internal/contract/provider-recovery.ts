import { observationOwn as own, projectProviderHttp, projectProviderRoute, type ProviderHttpObservation, type ProviderRouteObservation } from "./provider-observation.ts";

/** Per-logical-STEP latency/spend policy, never a service lifetime quota.
 * Retrying a POST may duplicate upstream inference/billing. Opt-in records that
 * tradeoff explicitly; Host tools are never replayed by this policy. */
export type ProviderRecoveryPolicy = {
  version: 1; mode: "off" | "pre-output-http"; allowDuplicateInference: boolean;
  maxExtraRequests: number; windowMs: number; baseDelayMs: number; maxDelayMs: number;
};
export const NO_PROVIDER_RECOVERY: ProviderRecoveryPolicy = Object.freeze({ version: 1, mode: "off", allowDuplicateInference: false,
  maxExtraRequests: 0, windowMs: 90_000, baseDelayMs: 1000, maxDelayMs: 10_000 });
export const RECOVERY_PHASES = ["disabled", "running", "waiting", "succeeded", "stopped", "cancelled"] as const;
export const RECOVERY_STOPS = ["disabled", "not_retryable", "output_observed", "attempt_budget", "deadline", "cancelled", "storage_unavailable", "authority_changed", "configuration_changed", "success", "pending"] as const;
export type ModelAttemptRecord = {
  id: string; ordinal: number; snapshotDigest: string; state: "claimed" | "dispatch_reserved" | "failed" | "completed" | "interrupted";
  startedAtMs: number; settledAtMs?: number; httpStatus?: number;
};
export type ProviderRecoveryState = {
  version: 1; policy: ProviderRecoveryPolicy; phase: typeof RECOVERY_PHASES[number]; stopReason: typeof RECOVERY_STOPS[number];
  startedAtMs: number; deadlineAtMs: number; nextAttemptAtMs?: number;
  attempts: ModelAttemptRecord[]; outcomeUncertain: boolean; settlementRecorded: boolean;
  lastUpstreamFailure?: { ordinal: number; http?: ProviderHttpObservation; route?: ProviderRouteObservation };
};
const uint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const member = <T extends string>(v: unknown, list: readonly T[]): T | undefined => typeof v === "string" && list.includes(v as T) ? v as T : undefined;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function projectProviderRecoveryPolicy(value: unknown): ProviderRecoveryPolicy | undefined {
  if (own(value,"version") !== 1) return;
  const mode = member(own(value,"mode"),["off","pre-output-http"]), allowDuplicateInference = own(value,"allowDuplicateInference");
  const maxExtraRequests = own(value,"maxExtraRequests"), windowMs = own(value,"windowMs"), baseDelayMs = own(value,"baseDelayMs"), maxDelayMs = own(value,"maxDelayMs");
  if (!mode || typeof allowDuplicateInference !== "boolean" || !uint(maxExtraRequests) || maxExtraRequests > 128
    || !uint(windowMs) || windowMs < 1 || windowMs > 600_000 || !uint(baseDelayMs) || baseDelayMs < 1
    || !uint(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > windowMs
    || (mode === "pre-output-http" && (!allowDuplicateInference || maxExtraRequests < 1))) return;
  return {version:1,mode,allowDuplicateInference,maxExtraRequests,windowMs,baseDelayMs,maxDelayMs};
}
export function providerRecoveryFromEnv(env: Readonly<Record<string,string|undefined>>): ProviderRecoveryPolicy {
  const mode = env.GROKBOX_MODELD_PROVIDER_RECOVERY ?? "off";
  if (mode === "off") return {...NO_PROVIDER_RECOVERY};
  if (mode !== "pre-output-http") throw Error("invalid_provider_recovery_policy");
  const read = (key: string, fallback: number) => {
    const text=env[key]; if(text===undefined)return fallback;
    if(!/^\d+$/.test(text))throw Error("invalid_provider_recovery_policy"); return Number(text);
  };
  const policy=projectProviderRecoveryPolicy({version:1,mode,allowDuplicateInference:true,
    maxExtraRequests:read("GROKBOX_MODELD_RECOVERY_EXTRA_REQUESTS",2),windowMs:read("GROKBOX_MODELD_RECOVERY_WINDOW_MS",90_000),
    baseDelayMs:read("GROKBOX_MODELD_RECOVERY_BASE_DELAY_MS",1000),maxDelayMs:read("GROKBOX_MODELD_RECOVERY_MAX_DELAY_MS",10_000)});
  if(!policy)throw Error("invalid_provider_recovery_policy");return policy;
}
export function projectProviderRecoveryState(value: unknown): ProviderRecoveryState | undefined {
  try {
    if(own(value,"version")!==1)return;
    const policy=projectProviderRecoveryPolicy(own(value,"policy")),phase=member(own(value,"phase"),RECOVERY_PHASES),stopReason=member(own(value,"stopReason"),RECOVERY_STOPS);
    const startedAtMs=own(value,"startedAtMs"),deadlineAtMs=own(value,"deadlineAtMs"),nextAttemptAtMs=own(value,"nextAttemptAtMs");
    const uncertain=own(value,"outcomeUncertain"),settled=own(value,"settlementRecorded"),raw=own(value,"attempts");
    if(!policy||!phase||!stopReason||!uint(startedAtMs)||!uint(deadlineAtMs)||deadlineAtMs<startedAtMs
      ||typeof uncertain!=="boolean"||typeof settled!=="boolean"||!Array.isArray(raw)||raw.length>129)return;
    const attempts:ModelAttemptRecord[]=[];
    for(let i=0;i<raw.length;i++){
      const r=own(raw,String(i)),id=own(r,"id"),ordinal=own(r,"ordinal"),snapshotDigest=own(r,"snapshotDigest");
      const state=member(own(r,"state"),["claimed","dispatch_reserved","failed","completed","interrupted"]),at=own(r,"startedAtMs"),end=own(r,"settledAtMs"),status=own(r,"httpStatus");
      if(!hash(id)||!hash(snapshotDigest)||ordinal!==i+1||!state||!uint(at)||at<startedAtMs||(end!==undefined&&(!uint(end)||end<at)))return;
      if(status!==undefined&&(!uint(status)||status<100||status>599))return;
      attempts.push({id,ordinal,snapshotDigest,state,startedAtMs:at,...(uint(end)?{settledAtMs:end}:{}),...(uint(status)?{httpStatus:status}:{})});
    }
    const detail = own(value,"lastUpstreamFailure"), ordinal = own(detail,"ordinal"), http = projectProviderHttp(own(detail,"http")), route = projectProviderRoute(own(detail,"route"));
    const lastUpstreamFailure = uint(ordinal) && ordinal > 0 && ordinal <= attempts.length && (http || route)
      ? { ordinal, ...(http ? { http } : {}), ...(route ? { route } : {}) } : undefined;
    return {version:1,policy,phase,stopReason,startedAtMs,deadlineAtMs,attempts,outcomeUncertain:uncertain,settlementRecorded:settled,
      ...(uint(nextAttemptAtMs)?{nextAttemptAtMs}:{}), ...(lastUpstreamFailure ? { lastUpstreamFailure } : {})};
  }catch{return;}
}
export function projectModelRecoveryProgress(value: unknown): Record<string, unknown> | null {
  try {
    if(own(value,"name")!=="model_recovery_progress"||own(value,"schemaVersion")!==1)return null;
    const at=own(value,"at"),recovery=projectProviderRecoveryState(own(value,"recovery"));
    if(typeof at!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at))||!recovery)return null;
    const out:Record<string,unknown>={name:"model_recovery_progress",schemaVersion:1,at,recovery};
    for(const key of ["agentId","turnId","stepId","hostGenerationId","serviceEpoch"]){const id=own(value,key);if(typeof id!=="string"||! /^[A-Za-z0-9_.:-]{1,128}$/.test(id))return null;out[key]=id;}
    return out;
  }catch{return null;}
}
const states = new WeakMap<object, ProviderRecoveryState>();
export function annotateProviderRecovery<T extends object>(error:T,state:ProviderRecoveryState):T {
  const safe=projectProviderRecoveryState(state);if(safe)states.set(error,safe);return error;
}
export function providerRecoveryOf(error:unknown):ProviderRecoveryState|undefined {
  return error!==null&&typeof error==="object"?projectProviderRecoveryState(states.get(error)):undefined;
}
