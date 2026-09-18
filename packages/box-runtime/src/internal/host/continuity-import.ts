import { CurrentStateFailure, applicationObservation, assertCapturedHead, assertNativeBinding, assertPublicationIdentity,
  copyNativeMaterial, nativeCurrentHead, preparedCurrentState, sameCurrentHead,
  type ContinuityStorePolicy, type InitializationAttempt, type NativeCaptureLease, type NativeCurrentHead,
  type NativeInitializationLease, type NativeMaterial, type NativeQualification, type PreparedCurrentState } from "@grokbox/runtime-kernel/continuity";

/** Effect-free validation at the native capability seam. These functions have
 * no filesystem/RPC access and cannot repair a missing root or load a Bot.
 * A qualified binding must supply a stable, finite, non-repairing read lease.
 * Checking two heads alone is NOT a replacement for that writer boundary. */
export async function captureNativeCurrentMaterial(lease: NativeCaptureLease, expected: NativeCurrentHead,
  qualification: NativeQualification, policy: ContinuityStorePolicy): Promise<NativeMaterial> {
  const before = nativeCurrentHead(await lease.readHead());
  assertNativeBinding(before, expected, qualification);
  if (!sameCurrentHead(before, expected)) throw new CurrentStateFailure("source_changed");
  if (before.rootHash === null) throw new CurrentStateFailure("material_invalid");
  const material = copyNativeMaterial(await lease.readMaterial({ maxParts: policy.maxParts,
    maxPartBytes: policy.maxPartBytes, maxSnapshotBytes: policy.maxSnapshotBytes }), policy);
  assertCapturedHead(material, before);
  const after = nativeCurrentHead(await lease.readHead());
  if (!sameCurrentHead(before, after)) throw new CurrentStateFailure("source_changed");
  return material;
}

/** Native preparation must validate/decode into a held candidate only. It must
 * not change the active root, identity, Memory, queues or emit business effects.
 * The actual opaque candidate remains in the native lease, never in RPC JSON. */
export async function prepareNativeCurrentMaterial(lease: NativeInitializationLease, material: NativeMaterial,
  attempt: InitializationAttempt, qualification: NativeQualification, policy: ContinuityStorePolicy): Promise<PreparedCurrentState> {
  const before = nativeCurrentHead(await lease.readHead());
  assertNativeBinding(before, attempt.expected, qualification);
  if (!sameCurrentHead(before, attempt.expected)) throw new CurrentStateFailure("source_changed");
  if (!["empty", "prepared"].includes(before.state) || before.effects !== "clear") throw new CurrentStateFailure("not_prepared");
  const frozen = copyNativeMaterial(material, policy);
  assertPublicationIdentity(frozen, attempt.snapshot);
  if (frozen.manifest.source.scopeId !== before.scopeId) throw new CurrentStateFailure("material_invalid");
  const candidate = preparedCurrentState(await lease.prepare(frozen, attempt), attempt);
  if (!sameCurrentHead(before, nativeCurrentHead(await lease.readHead()))) throw new CurrentStateFailure("source_changed");
  return candidate;
}

/** Reopen while the native preparation fence still holds, then read a native
 * application receipt AND the actual current root. A commit callback returning
 * successfully, a management record, or a model saying 'remembered' is not proof.
 * This checks the fresh apply; later reconciliation may observe newer B1/B2. */
export async function verifyNativeCurrentApplication(lease: NativeInitializationLease, attempt: InitializationAttempt,
  candidate: PreparedCurrentState, qualification: NativeQualification) {
  const reopened = nativeCurrentHead(await lease.reopen());
  assertNativeBinding(reopened, attempt.expected, qualification);
  const observation = applicationObservation(await lease.application(attempt), attempt);
  if (observation.state !== "applied" || !sameCurrentHead(reopened, observation.current)
    || reopened.hostGeneration !== attempt.expected.hostGeneration
    || reopened.state !== "prepared" || reopened.effects !== "clear" || reopened.rootHash !== candidate.rootHash
    || observation.marker.candidateHash !== candidate.candidateHash || observation.marker.rootHash !== candidate.rootHash
    || reopened.contextRevision !== observation.marker.contextRevision || reopened.contextRevision === attempt.expected.contextRevision) {
    throw new CurrentStateFailure("commit_unknown");
  }
  return observation;
}
