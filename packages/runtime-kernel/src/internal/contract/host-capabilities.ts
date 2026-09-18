import { OWNERSHIP_LOCAL_SOURCE } from "./ownership.ts";

/** Loaded bridge evidence only. Never a Bot admission permit or Provider receipt. */
export type LoadedHostIdentity = {
  pid: number;
  start: number;
  profileSha256: string;
  sourceSha256: string;
  transformedSha256: string;
};
export type LoadedHostCapabilities = {
  version: 1;
  source: "Host.loaded-runtime-capabilities";
  ownershipLocal: { wrapperVersion: 1; readerVersion: 1; schemaVersion: 1; source: typeof OWNERSHIP_LOCAL_SOURCE };
  loaded: LoadedHostIdentity;
};
export type HostCapabilityReport = {
  state: "ready" | "not_instrumented" | "incompatible" | "unavailable";
  reason: "matched" | "missing_manifest" | "invalid_manifest" | "generation_mismatch" | "loaded_profile_mismatch" | "expected_profile_unavailable" | "observation_unavailable";
  observed?: LoadedHostCapabilities;
};
const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Strict finite projection. Unknown fields/strings and accessors are never copied. */
export function projectLoadedHostCapabilities(value: unknown): LoadedHostCapabilities | undefined {
  try {
    const local = own(value, "ownershipLocal"), loaded = own(value, "loaded");
    const pid = own(loaded, "pid"), start = own(loaded, "start");
    const profileSha256 = own(loaded, "profileSha256"), sourceSha256 = own(loaded, "sourceSha256"), transformedSha256 = own(loaded, "transformedSha256");
    if (own(value, "version") !== 1 || own(value, "source") !== "Host.loaded-runtime-capabilities"
      || own(local, "wrapperVersion") !== 1 || own(local, "readerVersion") !== 1 || own(local, "schemaVersion") !== 1 || own(local, "source") !== OWNERSHIP_LOCAL_SOURCE
      || !positive(pid) || !positive(start) || !sha(profileSha256) || !sha(sourceSha256) || !sha(transformedSha256)) return undefined;
    return { version: 1, source: "Host.loaded-runtime-capabilities",
      ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE },
      loaded: { pid, start, profileSha256, sourceSha256, transformedSha256 } };
  } catch { return undefined; }
}

/** The installed reader and the actually executed wrapper must both opt in. */
export function loadedHostCapabilities(identity: LoadedHostIdentity | undefined, wrapperVersion: unknown): LoadedHostCapabilities | null {
  if (wrapperVersion !== 1) return null;
  return projectLoadedHostCapabilities({ version: 1, source: "Host.loaded-runtime-capabilities", loaded: identity,
    ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE } }) ?? null;
}

export function assessLoadedHostCapabilities(value: unknown, expected: {
  gatewayPid: number;
  hostStart?: number;
  profile?: Pick<LoadedHostIdentity, "profileSha256" | "sourceSha256" | "transformedSha256">;
}): HostCapabilityReport {
  if (value === undefined || value === null) return { state: "not_instrumented", reason: "missing_manifest" };
  const observed = projectLoadedHostCapabilities(value);
  if (!observed) return { state: "incompatible", reason: "invalid_manifest" };
  if (observed.loaded.pid !== expected.gatewayPid || expected.hostStart !== undefined && observed.loaded.start !== expected.hostStart) {
    return { state: "incompatible", reason: "generation_mismatch", observed };
  }
  if (!expected.profile) return { state: "unavailable", reason: "expected_profile_unavailable", observed };
  if (observed.loaded.profileSha256 !== expected.profile.profileSha256 || observed.loaded.sourceSha256 !== expected.profile.sourceSha256
    || observed.loaded.transformedSha256 !== expected.profile.transformedSha256) {
    return { state: "incompatible", reason: "loaded_profile_mismatch", observed };
  }
  return { state: "ready", reason: "matched", observed };
}
