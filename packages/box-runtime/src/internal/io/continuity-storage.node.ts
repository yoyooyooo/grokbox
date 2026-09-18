import { CONTINUITY_STORAGE_OWNERS, ownerMeasurement, ownedMaintenanceReceipt, referenceChange, referenceReceipt,
  type ContinuityStorageOwnerId, type ContinuityStorageOwner, type ContinuityStorageOwners, type ReferenceChange } from "@grokbox/runtime-kernel/observation";

function ownerFor(ports: ContinuityStorageOwners, id: ContinuityStorageOwnerId): ContinuityStorageOwner | undefined {
  const owner = id === "continuity.recovery" ? ports.recovery : ports.safety;
  if (owner && owner.owner !== id) throw new Error("continuity_owner_mismatch");
  return owner;
}
/** Only explicit dependency injection. No discovery, directory scans, global
 * registry, fallback owner or automatic allocation added to the diagnostic pool. */
export async function measureContinuityStorage(ports: ContinuityStorageOwners = {}) {
  const rows = [];
  const physical = new Map<string, number>(); let conflict = false;
  for (const id of CONTINUITY_STORAGE_OWNERS) {
    try {
      const owner = ownerFor(ports, id);
      if (!owner) { rows.push({ owner: id, state: "unmeasured" as const, measurement: null }); continue; }
      const measurement = ownerMeasurement(await owner.measure(), id);
      for (const allocation of measurement.allocations) {
        const prior = physical.get(allocation.allocationId);
        if (prior !== undefined && prior !== allocation.allocatedBytes) conflict = true;
        physical.set(allocation.allocationId, Math.max(prior ?? 0, allocation.allocatedBytes));
      }
      rows.push({ owner: id, state: "measured" as const, measurement });
    } catch { rows.push({ owner: id, state: "unavailable" as const, measurement: null }); }
  }
  const total = [...physical.values()].reduce((a, b) => a + b, 0);
  const complete = !conflict && Number.isSafeInteger(total) && rows.every(r => r.state === "measured" && r.measurement?.coverage === "complete");
  return { owners: rows, knownAllocatedBytes: rows.some(r => r.state === "measured") && Number.isSafeInteger(total) ? total : null,
    coverage: complete ? "complete" as const : "partial" as const,
    allocationConflict: conflict, accounting: "deduplicated_owner_allocations" as const, sampling: "per_owner_non_atomic" as const,
    addedToDiagnosticFootprint: false, deletionAuthorized: false, installationBudgetEnforced: false };
}
export async function maintainContinuityStorage(ports: ContinuityStorageOwners = {}, nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) throw new Error("continuity_invalid_time");
  const rows = [];
  for (const id of CONTINUITY_STORAGE_OWNERS) {
    try {
      const owner = ownerFor(ports, id);
      if (!owner) { rows.push({ owner: id, state: "unmeasured" as const, receipt: null }); continue; }
      const receipt = ownedMaintenanceReceipt(await owner.maintain({ nowMs, maxItems: 64 }), id);
      rows.push({ owner: id, state: "observed" as const, receipt });
    } catch { rows.push({ owner: id, state: "unavailable" as const, receipt: null }); }
  }
  return rows;
}
/** Called only for an explicit owner operation. Registration/GET never gets here.
 * The domain's implementation MUST serialize this with its own GC and persist
 * request identity; this bridge neither installs locks nor records a second pin. */
export async function changeContinuityReference(ports: ContinuityStorageOwners, input: ReferenceChange) {
  let request: ReferenceChange;
  try { request = referenceChange(input); } catch { return { state: "unsupported" as const, effect: "not_attempted" as const }; }
  let owner: ContinuityStorageOwner | undefined;
  try { owner = ownerFor(ports, request.reference.owner); }
  catch { return { state: "unsupported" as const, effect: "not_attempted" as const }; }
  if (!owner) return { state: "unavailable" as const, effect: "not_attempted" as const };
  try {
    const receipt = referenceReceipt(await owner.changeReference(request), request);
    return { state: "observed" as const, receipt, effect: "owner_receipt" as const };
  } catch {
    // A thrown request or malformed response may follow a committed domain write.
    // Never fabricate absence, release a pin or automatically retry.
    return { state: "unknown" as const, requestId: request.requestId, effect: "reconcile_with_owner" as const };
  }
}
