import type { ProcessIdentity, ProcessPort, StableProcessIdentity } from "./process.ts";
import { stableIdentitiesMatch } from "./process.ts";

export type OfficialRole = "wrapper" | "supervisor" | "host";
export type RoleClassifier = (
  identity: ProcessIdentity,
) => OfficialRole | "temp-supervisor" | "guardian" | null;

export type OfficialChain = {
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
};

export type AdoptedHostEvidence = {
  gatewayPid: number | null;
  expectedHost?: StableProcessIdentity;
};

function collectUniqueOfficial(
  port: ProcessPort,
  classify: RoleClassifier,
): { ok: true; chain: OfficialChain } | { ok: false; code: "duplicate-role" | "missing-role" } {
  const found: Partial<Record<OfficialRole, ProcessIdentity[]>> = {};
  for (const ident of port.list()) {
    const role = classify(ident);
    if (role !== "wrapper" && role !== "supervisor" && role !== "host") continue;
    found[role] = [...(found[role] ?? []), ident];
  }
  for (const role of ["wrapper", "supervisor", "host"] as const) {
    const rows = found[role] ?? [];
    if (rows.length > 1) return { ok: false, code: "duplicate-role" };
    if (rows.length === 0) return { ok: false, code: "missing-role" };
  }
  return {
    ok: true,
    chain: { wrapper: found.wrapper![0]!, supervisor: found.supervisor![0]!, host: found.host![0]! },
  };
}

export function findUniqueOfficialChain(
  port: ProcessPort,
  classify: RoleClassifier,
): { ok: true; chain: OfficialChain } | { ok: false; code: "duplicate-role" | "missing-role" | "bad-parentage" } {
  const unique = collectUniqueOfficial(port, classify);
  if (!unique.ok) return unique;
  const { wrapper, supervisor, host } = unique.chain;
  if (supervisor.ppid !== wrapper.pid || host.ppid !== supervisor.pid) {
    return { ok: false, code: "bad-parentage" };
  }
  return unique;
}

export function findAdoptedHostState(
  port: ProcessPort,
  classify: RoleClassifier,
  evidence: AdoptedHostEvidence,
):
  | { ok: true; state: OfficialChain }
  | {
      ok: false;
      code:
        | "duplicate-role"
        | "missing-role"
        | "bad-parentage"
        | "still-supervisor-child"
        | "gateway-mismatch"
        | "identity-mismatch";
    } {
  const unique = collectUniqueOfficial(port, classify);
  if (!unique.ok) return unique;
  const { wrapper, supervisor, host } = unique.chain;
  if (supervisor.ppid !== wrapper.pid) return { ok: false, code: "bad-parentage" };
  if (host.ppid === supervisor.pid) return { ok: false, code: "still-supervisor-child" };
  if (evidence.gatewayPid == null || evidence.gatewayPid !== host.pid) {
    return { ok: false, code: "gateway-mismatch" };
  }
  if (evidence.expectedHost && !stableIdentitiesMatch(evidence.expectedHost, host)) {
    return { ok: false, code: "identity-mismatch" };
  }
  return { ok: true, state: unique.chain };
}

export function proveStableOfficialState(
  port: ProcessPort,
  classify: RoleClassifier,
  evidence?: AdoptedHostEvidence,
):
  | { ok: true; mode: "direct-launch" | "transient-adopt"; chain: OfficialChain }
  | { ok: false; code: string } {
  const unique = findUniqueOfficialChain(port, classify);
  if (unique.ok) return { ok: true, mode: "direct-launch", chain: unique.chain };
  const adopted = findAdoptedHostState(port, classify, evidence ?? { gatewayPid: null });
  if (adopted.ok) return { ok: true, mode: "transient-adopt", chain: adopted.state };
  return { ok: false, code: unique.code === "bad-parentage" ? adopted.code : unique.code };
}

export function loadReviewedProfile(
  profile: { sourceSha256?: string; slices?: unknown },
  liveSha: string,
): { ok: true } | { ok: false; code: "unknown-sha" | "unreviewed-profile" } {
  if (typeof profile.sourceSha256 !== "string" || profile.sourceSha256.length < 8) {
    return { ok: false, code: "unreviewed-profile" };
  }
  if (profile.sourceSha256 !== liveSha) return { ok: false, code: "unknown-sha" };
  return { ok: true };
}
