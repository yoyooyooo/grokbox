import { EnvelopeError } from "@grokbox/runtime-kernel/contract";

export type HostRootSource = "state-system" | "independent";

export type HostRootContract = {
  profileId: string;
  abiIdentity: string;
  rootSource: HostRootSource;
};

/** T21 self-authored profiles. Unknown profile/ABI is not qualified. */
export const HOST_ROOT_CONTRACTS: readonly HostRootContract[] = [
  { profileId: "t21-state-root", abiIdentity: "host-abi-v1", rootSource: "state-system" },
  { profileId: "t21-independent-root", abiIdentity: "host-abi-v1", rootSource: "independent" },
];

export function qualifyHostRootContract(profileId: string, abiIdentity: string): HostRootContract {
  const found = HOST_ROOT_CONTRACTS.find((row) => row.profileId === profileId && row.abiIdentity === abiIdentity);
  if (!found) throw new EnvelopeError("invalid_envelope");
  return found;
}

/** Snapshot-root contracts only. Unknown patch profileIds stay unqualified (no live fail-close). */
export function lookupHostRootContract(profileId: string | undefined): HostRootContract | undefined {
  if (typeof profileId !== "string" || profileId.length === 0) return undefined;
  return HOST_ROOT_CONTRACTS.find((row) => row.profileId === profileId);
}
