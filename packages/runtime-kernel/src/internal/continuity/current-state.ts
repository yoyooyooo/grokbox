import { canonicalJson, sha256Bytes, sha256Text } from "../../hash.ts";
import { OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "../contract/ownership.ts";
import { continuityObject, continuityUint, isContinuityHash, isContinuityToken, isContinuityUuid,
  recoveryManifest, recoveryRevision, type ContinuityStorePolicy, type RecoveryManifest } from "./material.ts";
import { protectedStorageRef, type ProtectedStorageRef } from "../observation/continuity-contract.ts";

export type CurrentStateFailureCode = "invalid_request" | "native_unavailable" | "qualification_mismatch" | "source_changed"
  | "not_prepared" | "ownership_unconfirmed" | "policy_changed" | "material_invalid" | "commit_unknown" | "cleanup_unknown" | "cancelled" | "operation_conflict";
export class CurrentStateFailure extends Error {
  constructor(readonly code: CurrentStateFailureCode) { super(`continuity_current_${code}`); this.name = "CurrentStateFailure"; }
}
const bad = (code: CurrentStateFailureCode = "invalid_request"): never => { throw new CurrentStateFailure(code); };
const object = (v: unknown, keys: readonly string[]) => {
  try { return continuityObject(v, keys); } catch { return bad(); }
};

/** A native writer revision, NOT a user-visible session. A fixed native root
 * slot is not a content/version identity and is intentionally absent here. */
export type NativeCurrentHead = {
  agentId: string; scopeId: string; hostSourceSha: string; nativeSchema: string; hostGeneration: string;
  contextRevision: string; activationEpoch: string; rootHash: string | null;
  state: "empty" | "prepared" | "active" | "interrupted"; effects: "clear" | "unresolved";
};
export function nativeCurrentHead(input: unknown): NativeCurrentHead {
  const v = object(input, ["agentId", "scopeId", "hostSourceSha", "nativeSchema", "hostGeneration", "contextRevision", "activationEpoch", "rootHash", "state", "effects"]);
  if (!isContinuityUuid(v.agentId) || !isContinuityHash(v.scopeId) || !isContinuityHash(v.hostSourceSha) || !isContinuityToken(v.nativeSchema)
    || !isContinuityToken(v.hostGeneration) || !isContinuityHash(v.contextRevision) || !isContinuityToken(v.activationEpoch)
    || !(v.rootHash === null || isContinuityHash(v.rootHash)) || !["empty", "prepared", "active", "interrupted"].includes(String(v.state))
    || !["clear", "unresolved"].includes(String(v.effects)) || v.state === "empty" && v.rootHash !== null) return bad();
  return { agentId: v.agentId, scopeId: v.scopeId, hostSourceSha: v.hostSourceSha, nativeSchema: v.nativeSchema,
    hostGeneration: v.hostGeneration, contextRevision: v.contextRevision, activationEpoch: v.activationEpoch,
    rootHash: v.rootHash as string | null, state: v.state as NativeCurrentHead["state"], effects: v.effects as NativeCurrentHead["effects"] };
}
export type NativeCurrentTarget = { agentId: string; scopeId: string };
export type NativeQualification = { hostSourceSha: string; nativeSchema: string };
export function nativeQualification(input: unknown): NativeQualification {
  const v = object(input, ["hostSourceSha", "nativeSchema"]);
  if (!isContinuityHash(v.hostSourceSha) || !isContinuityToken(v.nativeSchema)) return bad();
  return { hostSourceSha: v.hostSourceSha, nativeSchema: v.nativeSchema };
}
export const sameCurrentHead = (a: NativeCurrentHead, b: NativeCurrentHead) => canonicalJson(a) === canonicalJson(b);
export function assertNativeBinding(head: NativeCurrentHead, target: NativeCurrentTarget, qualification: NativeQualification) {
  if (head.agentId !== target.agentId || head.scopeId !== target.scopeId) return bad("source_changed");
  if (head.hostSourceSha !== qualification.hostSourceSha || head.nativeSchema !== qualification.nativeSchema) return bad("qualification_mismatch");
}
export type NativeMaterial = { manifest: RecoveryManifest; content: ReadonlyMap<string, Uint8Array> };
/** Copies before the next await. This proves bytes/declared references only;
 * native codec completeness remains the reviewed Host binding's obligation. */
export function copyNativeMaterial(input: NativeMaterial, policy: ContinuityStorePolicy): NativeMaterial {
  try {
    const manifest = recoveryManifest(input.manifest, policy), content = new Map<string, Uint8Array>();
    if (!(input.content instanceof Map)) return bad("material_invalid");
    for (const part of manifest.parts) {
      if (content.has(part.hash)) continue;
      const raw = input.content.get(part.hash);
      if (!(raw instanceof Uint8Array) || raw.byteLength !== part.bytes) return bad("material_invalid");
      const bytes = Uint8Array.from(raw);
      if (sha256Bytes(bytes) !== part.hash) return bad("material_invalid");
      content.set(part.hash, bytes);
    }
    if (content.size !== input.content.size) return bad("material_invalid");
    return { manifest, content };
  } catch (e) { if (e instanceof CurrentStateFailure) throw e; return bad("material_invalid"); }
}
export function assertCapturedHead(material: NativeMaterial, head: NativeCurrentHead) {
  const m = material.manifest, root = m.parts.find(p => p.id === m.root);
  if (m.quality !== "native_checkpoint" || m.source.agentId !== head.agentId || m.source.scopeId !== head.scopeId
    || m.source.nativeSchema !== head.nativeSchema || m.source.contextRevision !== head.contextRevision
    || head.rootHash === null || root?.kind !== "native-root" || root.hash !== head.rootHash
    || head.effects === "unresolved" && !m.gaps.includes("unknown_effects")) return bad("material_invalid");
}
export type CaptureCurrentRequest = { requestId: string; expected: NativeCurrentHead };
export function captureCurrentRequest(input: unknown): CaptureCurrentRequest {
  const v = object(input, ["requestId", "expected"]);
  if (!isContinuityUuid(v.requestId)) return bad();
  return { requestId: v.requestId, expected: nativeCurrentHead(v.expected) };
}
export type InitializeCurrentRequest = { operationId: string; effectId: string; snapshot: ProtectedStorageRef; expected: NativeCurrentHead; policyRevision: string };
export function initializeCurrentRequest(input: unknown): InitializeCurrentRequest {
  const v = object(input, ["operationId", "effectId", "snapshot", "expected", "policyRevision"]);
  if (!isContinuityUuid(v.operationId) || !isContinuityUuid(v.effectId) || !isContinuityHash(v.policyRevision)) return bad();
  let snapshot: ProtectedStorageRef;
  try { snapshot = protectedStorageRef(v.snapshot); } catch { return bad(); }
  if (snapshot.owner !== "continuity.recovery" || !isContinuityUuid(snapshot.ref) || !isContinuityHash(snapshot.revision)) return bad();
  const expected = nativeCurrentHead(v.expected);
  if (!["empty", "prepared"].includes(expected.state) || expected.effects !== "clear") return bad("not_prepared");
  return { operationId: v.operationId, effectId: v.effectId, snapshot, expected, policyRevision: v.policyRevision };
}
export const initializationDigest = (request: InitializeCurrentRequest) => sha256Text(canonicalJson(request));
export type InitializationAttempt = InitializeCurrentRequest & { inputDigest: string };
export type PreparedCurrentState = { candidateHash: string; rootHash: string; inputDigest: string };
export function preparedCurrentState(value: unknown, attempt: InitializationAttempt): PreparedCurrentState {
  const v = object(value, ["candidateHash", "rootHash", "inputDigest"]);
  if (!isContinuityHash(v.candidateHash) || !isContinuityHash(v.rootHash) || v.inputDigest !== attempt.inputDigest) return bad("material_invalid");
  return { candidateHash: v.candidateHash, rootHash: v.rootHash, inputDigest: attempt.inputDigest };
}
/** Persisted by the native owner alongside the accepted state. A controller
 * ledger row or an LLM assertion is not a native application receipt. */
export type NativeApplicationMarker = {
  version: 1; operationId: string; effectId: string; agentId: string; scopeId: string; inputDigest: string;
  snapshotRevision: string; candidateHash: string; rootHash: string; contextRevision: string; nativeSchema: string;
};
export type NativeApplicationObservation = { state: "applied"; marker: NativeApplicationMarker; current: NativeCurrentHead }
  | { state: "absent" | "unknown"; current: NativeCurrentHead | null };
export function applicationObservation(input: unknown, attempt: InitializationAttempt): NativeApplicationObservation {
  const v = object(input, ["state", "marker", "current"]);
  if (!["applied", "absent", "unknown"].includes(String(v.state))) return bad("commit_unknown");
  const current = v.current === null ? null : nativeCurrentHead(v.current);
  if (current && (current.agentId !== attempt.expected.agentId || current.scopeId !== attempt.expected.scopeId)) return bad("commit_unknown");
  if (v.state !== "applied") {
    if (v.marker !== undefined) return bad("commit_unknown");
    return { state: v.state as "absent" | "unknown", current };
  }
  const m = object(v.marker, ["version", "operationId", "effectId", "agentId", "scopeId", "inputDigest", "snapshotRevision", "candidateHash", "rootHash", "contextRevision", "nativeSchema"]);
  if (!current || m.version !== 1 || m.operationId !== attempt.operationId || m.effectId !== attempt.effectId
    || m.agentId !== attempt.expected.agentId || m.scopeId !== attempt.expected.scopeId || m.inputDigest !== attempt.inputDigest
    || m.snapshotRevision !== attempt.snapshot.revision || m.nativeSchema !== attempt.expected.nativeSchema
    || !isContinuityHash(m.candidateHash) || !isContinuityHash(m.rootHash) || !isContinuityHash(m.contextRevision)) return bad("commit_unknown");
  return { state: "applied", current, marker: { version: 1, operationId: attempt.operationId, effectId: attempt.effectId,
    agentId: attempt.expected.agentId, scopeId: attempt.expected.scopeId, inputDigest: attempt.inputDigest, snapshotRevision: attempt.snapshot.revision,
    candidateHash: m.candidateHash, rootHash: m.rootHash, contextRevision: m.contextRevision, nativeSchema: attempt.expected.nativeSchema } };
}
export const nativeApplicationDigest = (marker: NativeApplicationMarker) => sha256Text(canonicalJson(marker));
export function assertPublicationIdentity(material: NativeMaterial, reference: ProtectedStorageRef) {
  if (reference.owner !== "continuity.recovery" || recoveryRevision(material.manifest) !== reference.revision) return bad("material_invalid");
}
export type InitializationPermission = { allowed: boolean; operationId: string; agentId: string; scopeId: string; policyRevision: string;
  ownership: "confirmed_box" | "unconfirmed"; observedAtMs: number; hostGeneration: string };
export function assertInitializationPermission(input: unknown, request: InitializeCurrentRequest, nowMs: number) {
  const v = object(input, ["allowed", "operationId", "agentId", "scopeId", "policyRevision", "ownership", "observedAtMs", "hostGeneration"]);
  if (v.operationId !== request.operationId || v.agentId !== request.expected.agentId || v.scopeId !== request.expected.scopeId
    || v.policyRevision !== request.policyRevision || v.allowed !== true) return bad("policy_changed");
  // observedAtMs is the ORIGINAL authority sample, never the time this receipt
  // was forwarded. Native dispatch must still enforce its own admission gate.
  if (v.ownership !== "confirmed_box" || v.hostGeneration !== request.expected.hostGeneration || !continuityUint(nowMs)
    || !continuityUint(v.observedAtMs) || nowMs < v.observedAtMs || nowMs - v.observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return bad("ownership_unconfirmed");
  return { allowed: true, operationId: request.operationId, agentId: request.expected.agentId, scopeId: request.expected.scopeId,
    policyRevision: request.policyRevision, ownership: "confirmed_box" as const, observedAtMs: v.observedAtMs, hostGeneration: v.hostGeneration as string };
}

export type NativeCaptureLimits = Pick<ContinuityStorePolicy, "maxParts" | "maxPartBytes" | "maxSnapshotBytes">;
export type NativeCaptureLease = {
  readHead: () => Promise<NativeCurrentHead>;
  /** Enforce these limits before allocating/reading the full native closure. */
  readMaterial: (limits: NativeCaptureLimits) => Promise<NativeMaterial>;
  release: () => Promise<void>;
};
export type NativeInitializationLease = {
  readHead: () => Promise<NativeCurrentHead>;
  prepare: (material: NativeMaterial, attempt: InitializationAttempt) => Promise<PreparedCurrentState>;
  commit: (attempt: InitializationAttempt, candidate: PreparedCurrentState) => Promise<void>;
  reopen: () => Promise<NativeCurrentHead>;
  application: (attempt: InitializationAttempt) => Promise<NativeApplicationObservation>;
  release: (disposition: "prepared" | "blocked") => Promise<void>;
};
/** Application-owned finite capability. Only a separately reviewed Host binding
 * may implement this for a product Bot. No implementation is auto-installed.
 * Capture is non-repairing under a stable checkpoint boundary. Target release
 * preserves preparation or a durable block; it never activates business work. */
export type NativeCurrentStatePort = {
  qualification: NativeQualification;
  capture: (expected: NativeCurrentHead) => Promise<NativeCaptureLease>;
  initialize: (attempt: InitializationAttempt) => Promise<NativeInitializationLease>;
  observeApplication: (attempt: InitializationAttempt) => Promise<NativeApplicationObservation>;
};
