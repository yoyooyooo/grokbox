import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { isDigest, isLifetime, sameLifetime, type Lifetime, type OriginalEvidence } from "./restoration-proof.ts";
import { parseAdoptLaunch, type AdoptLaunch } from "./adopt-evidence.ts";

/** An explicit local-maintainer trust boundary for historical facts software cannot
 * recover. It is dated now; it neither invents creation receipts nor trusts saved probes. */
export type CurrentRestorationQualification = {
  version: 1; kind: "maintainer-qualified-current-retirement"; operationId: string; qualifiedAt: string; qualifierUid: number;
  provenance: { supportedWriterSha256: string; launchSha256: string; inventorySha256: string; pidViewSha256: string; clockCalibrationSha256: string; allocationSha256: string };
  original: OriginalEvidence; launch: AdoptLaunch;
  view: { bootId: string; pid: string; time: string; mnt: string; anchor: Lifetime; clock: { anchor: Lifetime; originalStart: number } };
  hostScope: { lowerInclusive: number; upper: Lifetime; invariant: "detached-session-leader" };
  resources: {
    // Every category is required even when the qualified inventory is empty.
    guardian: Lifetime[]; holder: Lifetime[]; delegatedNative: Lifetime[]; delegatedTools: Lifetime[]; restartOwners: Lifetime[];
    scopes: Array<{ role: "guardian" | "holder" | "delegatedNative" | "delegatedTools" | "restartOwners";
      lowerInclusive: number; upper: Lifetime; qualificationSha256: string; retirement: "absence" | "node-image-or-absence" }>;
    roots: string[]; inodes: Array<{ dev: number; ino: number }>;
    independentOwners: Lifetime[];
    modeld: { kind: "absent"; owners: Lifetime[]; socketPath: string };
  };
  replacements: Array<{ lifetime: Lifetime; imageSha256: string; librarySha256: string[]; qualificationSha256: string;
    descriptors: Array<{ fd: number; digest: string }> }>;
};

function requireKeys(value: unknown, keys: string[]) {
  requireFact(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.sort().join(","));
}
function requireFact(ok: unknown): asserts ok { if (!ok) throw Error("restoration-qualification-invalid"); }
export function parseCurrentRestorationQualification(value: unknown, operationId: string, original: OriginalEvidence, root: string, uid: number): CurrentRestorationQualification {
  const q = value as CurrentRestorationQualification;
  requireKeys(q, ["version", "kind", "operationId", "qualifiedAt", "qualifierUid", "provenance", "original", "launch", "view", "hostScope", "resources", "replacements"]);
  requireKeys(q.provenance, ["supportedWriterSha256", "launchSha256", "inventorySha256", "pidViewSha256", "clockCalibrationSha256", "allocationSha256"]);
  requireKeys(q.view, ["bootId", "pid", "time", "mnt", "anchor", "clock"]);
  requireKeys(q.view.clock, ["anchor", "originalStart"]);
  requireKeys(q.hostScope, ["lowerInclusive", "upper", "invariant"]);
  requireKeys(q.resources, ["guardian", "holder", "delegatedNative", "delegatedTools", "restartOwners", "roots", "inodes", "independentOwners", "modeld", "scopes"]);
  requireFact(q && q.version === 1 && q.kind === "maintainer-qualified-current-retirement" && q.operationId === operationId
    && q.qualifierUid === uid && typeof q.qualifiedAt === "string" && Number.isFinite(Date.parse(q.qualifiedAt)) && Date.parse(q.qualifiedAt) <= Date.now()
    && isDeepStrictEqual(q.original, original));
  requireFact(q.provenance && [q.provenance.supportedWriterSha256, q.provenance.launchSha256, q.provenance.inventorySha256,
    q.provenance.pidViewSha256, q.provenance.clockCalibrationSha256, q.provenance.allocationSha256].every(isDigest));
  const launch = parseAdoptLaunch(q.launch);
  requireFact(launch.uid === uid && launch.rootDigest === sha256Text(resolve(root)));
  requireFact(q.view && /^[a-f0-9-]{36}$/.test(q.view.bootId) && isLifetime(q.view.anchor));
  for (const key of ["pid", "time", "mnt"] as const) requireFact(new RegExp(`^${key}:\\[[0-9]+\\]$`).test(q.view[key]));
  requireFact(q.view.clock && isLifetime(q.view.clock.anchor) && Number.isSafeInteger(q.view.clock.originalStart)
    && q.view.clock.originalStart > 0 && Math.abs(q.view.clock.anchor.start - q.view.clock.originalStart) <= 1);
  requireFact(q.hostScope && Number.isSafeInteger(q.hostScope.lowerInclusive) && q.hostScope.lowerInclusive > 0
    && isLifetime(q.hostScope.upper) && q.hostScope.lowerInclusive <= q.hostScope.upper.start && q.hostScope.invariant === "detached-session-leader");
  const resources = q.resources;
  requireFact(resources);
  for (const key of ["guardian", "holder", "delegatedNative", "delegatedTools", "restartOwners", "independentOwners"] as const) {
    requireFact(Array.isArray(resources[key]) && resources[key].length <= 4096 && resources[key].every(isLifetime));
  }
  requireFact(Array.isArray(resources.scopes) && resources.scopes.length <= 64);
  for (const scope of resources.scopes) requireFact(["guardian", "holder", "delegatedNative", "delegatedTools", "restartOwners"].includes(scope.role)
    && Number.isSafeInteger(scope.lowerInclusive) && scope.lowerInclusive > 0 && isLifetime(scope.upper) && scope.lowerInclusive <= scope.upper.start
    && isDigest(scope.qualificationSha256) && (scope.retirement === "absence" || scope.retirement === "node-image-or-absence" && ["guardian", "holder"].includes(scope.role)));
  requireFact(Array.isArray(resources.roots) && resources.roots.length > 0 && resources.roots.length <= 64
    && resources.roots.every(path => typeof path === "string" && path.startsWith("/") && path.length > 1 && path === resolve(path)));
  requireFact(Array.isArray(resources.inodes) && resources.inodes.length <= 4096 && resources.inodes.every(row => row && Number.isSafeInteger(row.dev)
    && row.dev >= 0 && Number.isSafeInteger(row.ino) && row.ino > 0));
  requireFact(resources.modeld && typeof resources.modeld.socketPath === "string" && resources.modeld.socketPath.startsWith("/"));
  requireKeys(resources.modeld, ["kind", "owners", "socketPath"]);
  requireFact(resources.modeld.kind === "absent" && Array.isArray(resources.modeld.owners) && resources.modeld.owners.every(isLifetime));
  requireFact(Array.isArray(q.replacements) && q.replacements.length <= 4096);
  for (const replacement of q.replacements) {
    requireKeys(replacement, ["lifetime", "imageSha256", "librarySha256", "qualificationSha256", "descriptors"]);
    requireFact(isLifetime(replacement.lifetime) && isDigest(replacement.imageSha256) && isDigest(replacement.qualificationSha256)
      && Array.isArray(replacement.librarySha256) && replacement.librarySha256.every(isDigest)
      && Array.isArray(replacement.descriptors) && replacement.descriptors.length <= 4096
      && replacement.descriptors.every(fd => Number.isSafeInteger(fd.fd) && fd.fd >= 0 && isDigest(fd.digest))
      && new Set(replacement.descriptors.map(fd => fd.fd)).size === replacement.descriptors.length);
  }
  requireFact(new Set(q.replacements.map(row => `${row.lifetime.pid}:${row.lifetime.start}`)).size === q.replacements.length);
  return structuredClone(q);
}

export type RetirementObservation = {
  version: 1; view: CurrentRestorationQualification["view"]; procMountSha256: string;
  census: Array<Lifetime & { pgid: number; sid: number; nspid: number[]; nstgid: number[] }>;
  candidates: Array<{ lifetime: Lifetime; relevantPreload: boolean; image: { sha256: string; libraries: string[]; anchorSha256: string };
    descriptors: Array<{ fd: number; digest: string; relevant: boolean; locked: boolean }> }>;
  resourceHolders: Lifetime[]; modeld: null;
};

/** The native adapter supplies observations, never an authorization boolean. */
export function validateRetirementObservation(q: CurrentRestorationQualification, observation: RetirementObservation, owners: Lifetime[], markerPid: number,
  official: Lifetime[], recoveryOwner: Lifetime, hosts: Lifetime[] = []): string {
  const o = observation;
  requireFact(o?.modeld === null);
  requireFact(o?.version === 1 && isDigest(o.procMountSha256) && isDeepStrictEqual(o.view, q.view) && Array.isArray(o.census) && Array.isArray(o.candidates) && Array.isArray(o.resourceHolders));
  requireFact(o.census.every(row => isLifetime(row) && Array.isArray(row.nspid) && Array.isArray(row.nstgid)
    && row.nspid[0] === row.pid && row.nstgid[0] === row.pid && [...row.nspid, ...row.nstgid].every(pid => Number.isSafeInteger(pid) && pid > 0))
    && new Set(o.census.map(row => row.pid)).size === o.census.length);
  const absent = [...owners, ...q.resources.guardian, ...q.resources.holder, ...q.resources.delegatedNative, ...q.resources.delegatedTools, ...q.resources.restartOwners,
    ...q.resources.modeld.owners];
  for (const owner of absent) if (o.census.some(row => sameLifetime(row, owner))) throw Error("restoration-required-owner-present");
  const inScope = (row: Lifetime, scope: CurrentRestorationQualification["resources"]["scopes"][number]) => row.start >= scope.lowerInclusive && row.start <= scope.upper.start && row.pid !== scope.upper.pid;
  for (const scope of q.resources.scopes) {
    requireFact(o.census.some(row => sameLifetime(row, scope.upper)));
    if (scope.retirement === "absence" && o.census.some(row => inScope(row, scope))) throw Error("restoration-required-owner-present");
  }
  const candidates = o.census.filter(row => q.resources.scopes.some(scope => scope.retirement === "node-image-or-absence" && inScope(row, scope)) || hosts.some(host => sameLifetime(row, host)) || row.nspid.includes(markerPid) || row.nstgid.includes(markerPid)
    || row.start >= q.hostScope.lowerInclusive && row.start <= q.hostScope.upper.start
      && row.pid !== q.hostScope.upper.pid && row.pgid === row.pid && row.sid === row.pid);
  requireFact(o.census.some(row => sameLifetime(row, q.view.anchor)) && o.census.some(row => sameLifetime(row, q.hostScope.upper))
    && o.candidates.length === candidates.length);
  for (const row of candidates) {
    const current = o.candidates.find(item => sameLifetime(item.lifetime, row)), reviewed = q.replacements.find(item => sameLifetime(item.lifetime, row));
    if (!current || !reviewed || current.relevantPreload !== false || current.image.sha256 !== reviewed.imageSha256 || !isDigest(current.image.anchorSha256)
      || current.image.libraries.some(sha => !reviewed.librarySha256.includes(sha)) || current.descriptors.some(fd => fd.relevant || fd.locked)
      || !isDeepStrictEqual(current.descriptors.map(({ fd, digest }) => ({ fd, digest })), reviewed.descriptors)) throw Error("restoration-image-or-resources-unproven");
  }
  const independent = [...official, recoveryOwner, ...q.resources.independentOwners];
  if (o.resourceHolders.some(owner => !independent.some(row => sameLifetime(row, owner)))) throw Error("restoration-resource-holder-present");
  // Stable exact census plus image/FD anchors are reobserved before each publication.
  return sha256Text(canonicalJson(o));
}
