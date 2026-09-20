/** A module-evaluation receipt, not native attachment, execution admission or
 * proof that the Host still runs. Pure projections are shared by all readers. */
export const HOST_COMPILE_CODES = ["compiled", "unknown-sha", "retired-slice", "slice-not-unique", "anchor-missing", "anchor-duplicate", "find-missing", "find-duplicate", "transformed-mismatch", "transform-failed", "native-compile-failed"] as const;
export type HostCompileCode = typeof HOST_COMPILE_CODES[number];
export type HostCompileReceipt = {
  version: 1; observationId: string; at: string; pid: number; start: number; uid: number;
  operationDigest: string; rootDigest: string; targetDigest: string; exeDigest: string; argvDigest: string;
  mode: "identity" | "route"; patch: "applied" | "refused"; nativeCompilation: "returned" | "threw";
  code: HostCompileCode; sourceSha: string; candidateSha: string | null; profileDigest: string; preloadDigest: string;
};
export type HostRuntimeObservation = {
  state: "not-observed" | "current" | "historical" | "invalid" | "unavailable";
  process: "same-generation" | "different-generation" | "absent-or-unverifiable" | "not-checked";
  observedAtMs: number; receipt: HostCompileReceipt | null;
  coverage: "selected-launch-marker"; attachment: "not-observed"; exercised: "not-exercised"; qualified: false;
};
export type HostRuntimeEvidence = {
  name: "host_runtime_health"; schemaVersion: 1; eventId: string; at: string; installationId: string;
  sourceInstanceId: string; sourceSequence: number; observation: HostRuntimeObservation;
};
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
function data(v: unknown, keys: readonly string[]): Record<string, any> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k] || !("value" in ds[k]!))) return null;
  return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
}
export function projectHostCompileReceipt(raw: unknown): HostCompileReceipt | null {
  const v = data(raw, ["version", "observationId", "at", "pid", "start", "uid", "operationDigest", "rootDigest", "targetDigest", "exeDigest", "argvDigest", "mode", "patch", "nativeCompilation", "code", "sourceSha", "candidateSha", "profileDigest", "preloadDigest"]);
  if (!v || v.version !== 1 || !uuid(v.observationId) || typeof v.at !== "string" || v.at.length > 32 || !Number.isFinite(Date.parse(v.at)) || new Date(v.at).toISOString() !== v.at
    || !integer(v.pid, 1) || !integer(v.start, 1) || !integer(v.uid) || ![v.operationDigest, v.rootDigest, v.targetDigest, v.exeDigest, v.argvDigest, v.sourceSha, v.profileDigest, v.preloadDigest].every(hash)
    || !["identity", "route"].includes(v.mode) || !["applied", "refused"].includes(v.patch) || !["returned", "threw"].includes(v.nativeCompilation)
    || !HOST_COMPILE_CODES.includes(v.code) || !(v.candidateSha === null || hash(v.candidateSha))) return null;
  if ((v.patch === "applied") !== (v.candidateSha !== null)
    || v.nativeCompilation === "threw" && v.code !== "native-compile-failed"
    || v.nativeCompilation === "returned" && (v.patch === "applied" ? v.code !== "compiled" : ["compiled", "native-compile-failed"].includes(v.code))) return null;
  return v as HostCompileReceipt;
}
export function projectHostRuntimeObservation(raw: unknown): HostRuntimeObservation | null {
  const v = data(raw, ["state", "process", "observedAtMs", "receipt", "coverage", "attachment", "exercised", "qualified"]);
  if (!v || !["not-observed", "current", "historical", "invalid", "unavailable"].includes(v.state)
    || !["same-generation", "different-generation", "absent-or-unverifiable", "not-checked"].includes(v.process)
    || !integer(v.observedAtMs, 1) || v.coverage !== "selected-launch-marker" || v.attachment !== "not-observed" || v.exercised !== "not-exercised" || v.qualified !== false) return null;
  const receipt = v.receipt === null ? null : projectHostCompileReceipt(v.receipt);
  if (v.receipt !== null && !receipt || (["current", "historical"].includes(v.state)) !== (receipt !== null)
    || v.state === "current" && v.process !== "same-generation"
    || v.state === "historical" && !["different-generation", "absent-or-unverifiable"].includes(v.process)
    || !receipt && v.process !== "not-checked" || receipt && Date.parse(receipt.at) > v.observedAtMs) return null;
  return { ...v, receipt } as HostRuntimeObservation;
}
export function projectHostRuntimeEvidence(raw: unknown): HostRuntimeEvidence | null {
  const v = data(raw, ["name", "schemaVersion", "eventId", "at", "installationId", "sourceInstanceId", "sourceSequence", "observation"]);
  if (!v || v.name !== "host_runtime_health" || v.schemaVersion !== 1 || !uuid(v.eventId) || !uuid(v.installationId) || !hash(v.sourceInstanceId)
    || !integer(v.sourceSequence) || typeof v.at !== "string" || v.at.length > 32 || !Number.isFinite(Date.parse(v.at))) return null;
  const observation = projectHostRuntimeObservation(v.observation);
  if (!observation || observation.observedAtMs > Date.parse(v.at)) return null;
  return { ...v, observation } as HostRuntimeEvidence;
}
export function hostRuntimeCondition(v: HostRuntimeEvidence): "failed" | "passed" | "unknown" {
  const o = v.observation, r = o.receipt;
  if (!r) return "unknown";
  if (r.nativeCompilation === "threw" || r.patch === "refused") return "failed";
  return o.state === "current" ? "passed" : "unknown";
}
