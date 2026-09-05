import type { ProcessIdentity, ProcessPort } from "./process.ts";

export type OfficialRole = "wrapper" | "supervisor" | "host";
export type RoleClassifier = (identity: ProcessIdentity) => OfficialRole | null;

export type OfficialChain = {
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
};

export function findUniqueOfficialChain(
  port: ProcessPort,
  classify: RoleClassifier,
): { ok: true; chain: OfficialChain } | { ok: false; code: "duplicate-role" | "missing-role" | "bad-parentage" } {
  const found: Partial<Record<OfficialRole, ProcessIdentity[]>> = {};
  for (const ident of port.list()) {
    const role = classify(ident);
    if (!role) continue;
    found[role] = [...(found[role] ?? []), ident];
  }
  for (const role of ["wrapper", "supervisor", "host"] as const) {
    const rows = found[role] ?? [];
    if (rows.length > 1) return { ok: false, code: "duplicate-role" };
    if (rows.length === 0) return { ok: false, code: "missing-role" };
  }
  const wrapper = found.wrapper![0]!;
  const supervisor = found.supervisor![0]!;
  const host = found.host![0]!;
  if (supervisor.ppid !== wrapper.pid || host.ppid !== supervisor.pid) {
    return { ok: false, code: "bad-parentage" };
  }
  return { ok: true, chain: { wrapper, supervisor, host } };
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
