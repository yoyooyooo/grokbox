import { reconcileMarkerCompilation } from "../io/host-compilation.node.ts";
import { adoptionEvidencePath, adoptionOwnerPath, parseAdoptLaunch } from "./adopt-evidence.ts";
import { constants, closeSync, fsyncSync, openSync, readSync, linkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { attestationPath } from "../io/authority.node.ts";
import { adoptOpStatePath, parseAdoptOpState } from "./transient-adopt.ts";
import { findUniqueOfficialChain, type RoleClassifier } from "./official-chain.ts";
import type { ProcessPort } from "./process-port.ts";

import { restorationSnapshot, restorationReceiptPath, readCompletedRestoration, validateCompletedRestoration, type RestorationReceipt, type OriginalEvidence } from "./restoration-proof.ts";
import { parseCurrentRestorationQualification, validateRetirementObservation, type CurrentRestorationQualification } from "./current-restoration.ts";
import type { RetirementObserver } from "./retirement-observer.node.ts";
export { restorationSnapshot, restorationReceiptPath } from "./restoration-proof.ts";
export type CurrentRestorationPorts = RetirementObserver & { recoveryOwner: { pid: number; start: number }; assertModeldAbsent: () => void };

export type RestorationPorts = {
  current?: CurrentRestorationPorts;
  processes: ProcessPort;
  classify: RoleClassifier;
  gatewayPid: () => number | null;
  /** Must throw on unavailable evidence, not return false. */
  hasRelevantPreload: (pid: number) => boolean;
};

/** Called only by the recovery owner while BOTH physical gates are held. This
 * publishes observation of restoration, never edits the failed operation. */
export function prepareOriginalRestoration(input: {
  operationId: string; runRoot: string; storePath: string; expectedOperation: unknown; ports: RestorationPorts; qualificationPath?: string;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.operationId)) throw new Error("restoration-operation-invalid");
  const { ports } = input;
  const sources = [restorationSnapshot(input.storePath), restorationSnapshot(adoptOpStatePath(input.runRoot)),
    restorationSnapshot(join(input.runRoot, "state", "preload-marker.json")), restorationSnapshot(attestationPath(input.runRoot), true)];
  const operations = JSON.parse(sources[0]!.bytes!.toString());
  if (!isDeepStrictEqual(operations[input.operationId], input.expectedOperation)) throw new Error("restoration-operation-changed");
  const journal = parseAdoptOpState(JSON.parse(sources[1]!.bytes!.toString()));
  const marker = JSON.parse(sources[2]!.bytes!.toString());
  const archivedJournal = restorationSnapshot(adoptionEvidencePath(input.runRoot, input.operationId, "journal"), true);
  const archivedMarker = restorationSnapshot(adoptionEvidencePath(input.runRoot, input.operationId, "marker"), true);
  if (archivedJournal.bytes && archivedJournal.sha256 !== sources[1]!.sha256 || archivedMarker.bytes && archivedMarker.sha256 !== sources[2]!.sha256) throw Error("restoration-original-evidence-changed");
  const ownerClaim = restorationSnapshot(adoptionOwnerPath(input.runRoot), true);
  const claim = ownerClaim.bytes ? JSON.parse(ownerClaim.bytes.toString()) : null;
  if (ownerClaim.bytes && (claim?.version !== 1 || claim.operationId !== input.operationId || claim.state !== "unresolved" || Object.keys(claim).length !== 3)) throw Error("restoration-owner-claim-unproven");
  sources.push(archivedJournal, archivedMarker, ownerClaim);
  const original = operations[input.operationId], diagnostic = original?.prefix?.diagnostic;
  const evidence: OriginalEvidence = { operations: sources[0]!.sha256!, journal: sources[1]!.sha256!, marker: sources[2]!.sha256!,
    attestation: sources[3]!.sha256, ownerClaim: ownerClaim.sha256, archivedJournal: archivedJournal.sha256, archivedMarker: archivedMarker.sha256 };
  let qualification: CurrentRestorationQualification | undefined;
  if (input.qualificationPath) {
    const qualified = restorationSnapshot(input.qualificationPath);
    if (!qualified.bytes || (qualified.identity![5]! & 0o077) !== 0) throw Error("restoration-qualification-unprotected");
    qualification = parseCurrentRestorationQualification(JSON.parse(qualified.bytes.toString()), input.operationId, evidence,
      dirname(dirname(input.storePath)), original.leaseOwner?.uid);
    if (qualification.view.bootId !== original.leaseOwner?.bootId || !journal.tempSupervisor
      || !journal.tempSupervisor.ancestry.includes(qualification.view.anchor.pid)
      || qualification.hostScope.lowerInclusive !== journal.tempSupervisor.start - 1
      || qualification.view.anchor.start >= qualification.hostScope.lowerInclusive
      || [journal.tempSupervisor.pid, marker.pid].includes(qualification.hostScope.upper.pid)) throw Error("restoration-qualified-scope-conflict");
    if (qualification.resources.modeld.socketPath !== join(input.runRoot, "modeld.sock")) throw Error("restoration-modeld-scope-conflict");
    if (![input.runRoot, dirname(dirname(input.storePath))].every(root => qualification!.resources.roots.includes(resolve(root)))) throw Error("restoration-resource-roots-incomplete");
    sources.push(qualified);
  }
  if (!qualification && (!archivedJournal.bytes || !archivedMarker.bytes || !ownerClaim.bytes)) throw Error("restoration-creation-provenance-unavailable");
  const creation = journal.creation;
  const identity = (row: unknown): row is { pid: number; start: number } & Record<string, unknown> => !!row && typeof row === "object"
    && Number.isSafeInteger((row as any).pid) && (row as any).pid > 0 && Number.isSafeInteger((row as any).start) && (row as any).start > 0;
  const same = (a: { pid: number; start: number }, b: { pid: number; start: number }) => a.pid === b.pid && a.start === b.start;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  // A current scope can replace absent history; existing history must still reconcile.
  if ((!qualification || Object.hasOwn(journal, "creation")) && (!creation || creation.version !== 1 || creation.operationId !== input.operationId || !diagnostic || !journal.failure
    || !isDeepStrictEqual(diagnostic, journal.failure) || ![creation.host, creation.tempSupervisor, creation.guardian, creation.holder].every(identity)
    || new Set([creation.host.pid, creation.tempSupervisor.pid, creation.guardian.pid, creation.holder.pid]).size !== 4
    || !creation.compile || typeof creation.compile.profileId !== "string" || !creation.compile.profileId.length || creation.compile.profileId.length > 128
    || ![creation.compile.profileSha256, creation.compile.sourceSha256, creation.compile.transformedSha256, creation.preloadSha256].every(hash)
    || !isDeepStrictEqual(marker.compile, creation.compile) || marker.preloadSha256 !== creation.preloadSha256
    || !identity(marker) || !same(marker, creation.host)
    || !identity(diagnostic.child) || !same(diagnostic.child, creation.host)
    || journal.tempSupervisor && !same(journal.tempSupervisor, creation.tempSupervisor)
    || journal.host && !same(journal.host, creation.host))) throw Error("restoration-creation-provenance-unavailable");
  const rootDigest = sha256Text(resolve(dirname(dirname(input.storePath))));
  const retainedLaunch = creation && Object.hasOwn(creation, "launch") ? parseAdoptLaunch(creation.launch) : undefined;
  if (retainedLaunch && (retainedLaunch.rootDigest !== rootDigest || retainedLaunch.uid !== original.leaseOwner?.uid
    || qualification && !isDeepStrictEqual(retainedLaunch, qualification.launch))) throw Error("restoration-launch-provenance-conflict");
  if (Object.hasOwn(marker, "compilationObservation")) {
    const launch = parseAdoptLaunch(retainedLaunch ?? qualification?.launch);
    if (launch.rootDigest !== rootDigest || launch.uid !== original.leaseOwner?.uid) throw Error("restoration-launch-provenance-conflict");
    const observation = reconcileMarkerCompilation(marker, { rootDigest, targetDigest: launch.targetDigest, uid: launch.uid, now: Date.now() });
    if (!observation || observation.pid !== marker.pid || observation.start !== marker.start
      || observation.mode !== launch.mode || observation.exeDigest !== launch.exeDigest || observation.argvDigest !== launch.argvDigest) throw Error("restoration-compilation-provenance-conflict");
  }
  if (Object.hasOwn(original.prefix ?? {}, "diagnostic") || Object.hasOwn(journal, "failure")) {
    if (!diagnostic || !journal.failure || !isDeepStrictEqual(diagnostic, journal.failure)) throw Error("restoration-failure-unproven");
  }
  const diagnosticChild = diagnostic && Object.hasOwn(diagnostic, "child") ? diagnostic.child : undefined;
  if (diagnostic && Object.hasOwn(diagnostic, "child") && !identity(diagnosticChild)) throw Error("restoration-child-provenance-unavailable");
  if (journal.host !== null && !identity(journal.host)) throw Error("restoration-child-provenance-unavailable");
  const hosts = [creation?.host, journal.host, diagnosticChild].filter(identity).map(({ pid, start }) => ({ pid, start }));
  if (hosts.some(host => !same(host, hosts[0]!) || journal.tempSupervisor && same(host, journal.tempSupervisor))) throw Error("restoration-owner-provenance-conflict");
  if (qualification) {
    const excluded = [qualification.hostScope.upper, qualification.view.anchor, qualification.view.clock.anchor,
      ...qualification.resources.scopes.map(scope => scope.upper), ...qualification.resources.independentOwners];
    if (hosts.some(host => excluded.some(owner => same(host, owner)))) throw Error("restoration-qualified-scope-conflict");
  }
  const cleanup = diagnostic?.cleanup ?? [];
  if (!Array.isArray(cleanup) || cleanup.some((row: { role: string; pid: number; start: number }) => !identity(row)
    || !creation || !["host", "temp-supervisor"].includes(row.role) || !same(row, row.role === "host" ? creation.host : creation.tempSupervisor))) throw Error("restoration-owner-provenance-conflict");
  const oldAttestation = sources[3]!.bytes ? JSON.parse(sources[3]!.bytes!.toString()) : null;
  if (journal.operationId !== input.operationId || marker.operationId !== input.operationId
    || journal.phase !== "recovery-required" || journal.compile || journal.failure?.phase === "commit-attestation"
    || journal.failure?.phase === "attested" || sources[3]!.bytes && (!oldAttestation || typeof oldAttestation.operationId !== "string" || oldAttestation.operationId === input.operationId)
    || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !Number.isSafeInteger(marker.start) || marker.start <= 0
    || marker.compiled !== true || marker.transformed !== true || marker.modeld !== false) throw new Error("restoration-commit-or-identity-unproven");
  if (journal.failure && (!["wrapper-stop", "term-old-host", "term-old-supervisor", "spawn-temp", "temp-host-ready", "term-temp", "await-adopt"].includes(journal.failure.phase)
    || typeof journal.failure.code !== "string" || journal.failure.recoveryRequired !== true)) throw new Error("restoration-failure-unproven");
  // A legacy failure journal overwrote its phase. Only retained pre-commit
  // shape (temp owner still recorded, no adopting owner) excludes commit ambiguity.
  if (!journal.failure && (!journal.tempSupervisor || journal.adoptingSupervisor)) throw new Error("restoration-commit-unproven");
  const owned = creation ? [creation.tempSupervisor, creation.host, creation.guardian, creation.holder, diagnostic.child, ...cleanup]
    : [journal.tempSupervisor, ...hosts].filter(identity);
  if (!creation && (!marker.compile || typeof marker.compile.profileId !== "string"
    || ![marker.compile.profileSha256, marker.compile.sourceSha256, marker.compile.transformedSha256, marker.preloadSha256].every(hash))) throw Error("restoration-compilation-provenance-conflict");
  const observe = () => {
    const rows = ports.processes.list();
    for (const row of rows) {
      const role = ports.classify(row);
      if (role === "temp-supervisor" || role === "guardian" || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg))) {
        throw new Error("restoration-owner-present");
      }
    }
    for (const owner of qualification ? [] : owned) {
      const current = ports.processes.inspectLifetime ? ports.processes.inspectLifetime(owner.pid) : ports.processes.inspect(owner.pid);
      if (current && current.start === owner.start) throw new Error("restoration-owner-present");
    }
    const census: ProcessPort = { ...ports.processes, list: () => rows };
    const unique = findUniqueOfficialChain(census, ports.classify);
    if (!unique.ok || ports.gatewayPid() !== unique.chain.host.pid) throw new Error("restoration-chain-unproven");
    for (const identity of Object.values(unique.chain)) {
      if (!isDeepStrictEqual(ports.processes.inspect(identity.pid), identity) || ports.hasRelevantPreload(identity.pid)) {
        throw new Error("restoration-identity-unproven");
      }
    }
    return unique.chain;
  };
  const chain = observe();
  const recheck = () => {
    for (const source of sources) {
      const current = restorationSnapshot(source.path, source.bytes === null);
      if (current.sha256 !== source.sha256 || !isDeepStrictEqual(current.identity, source.identity)) throw new Error("restoration-evidence-conflict");
    }
    ports.processes.recheckDiscovery?.();
    if (!isDeepStrictEqual(observe(), chain)) throw new Error("restoration-chain-changed");
  };
  const receipt: RestorationReceipt = {
    version: 2, operationId: input.operationId, physicallyRestored: true, adopted: false, replayAuthorized: false,
    evidence,
    proof: { kind: qualification ? "qualified-modeld-absent-retirement" : "exact-lifetime-absence", observedAt: new Date().toISOString(),
      qualificationSha256: qualification ? sources.at(-1)!.sha256 : null, observationSha256: null },
    chain: Object.fromEntries(Object.entries(chain).map(([role, row]) => [role, { pid: row.pid, start: row.start, uid: row.uid, ppid: row.ppid }])),
    gatewayPid: chain.host.pid,
  };
  const path = restorationReceiptPath(input.runRoot, input.operationId);
  const verify = async (current?: CurrentRestorationPorts) => {
    recheck();
    if (qualification) {
      if (!current) throw Error("restoration-observer-unavailable");
      current.assertModeldAbsent();
      const absent = creation ? [creation.tempSupervisor, creation.guardian, creation.holder] : journal.tempSupervisor ? [journal.tempSupervisor] : [];
      const observed = await current.observe(qualification, { hosts, markerPid: marker.pid });
      const digest = validateRetirementObservation(qualification, observed, absent, marker.pid, Object.values(chain), current.recoveryOwner, hosts);
      if (receipt.proof.observationSha256 !== null && receipt.proof.observationSha256 !== digest) throw Error("restoration-observation-changed");
      receipt.proof.observationSha256 = digest;
      current.assertModeldAbsent();
      recheck();
    }
  };
  return { receipt, qualification, publish: async (current?: CurrentRestorationPorts, signal?: AbortSignal, recheckOwnership: () => Promise<void> = async () => {}) => {
    const cancelled = () => { if (signal?.aborted) throw Error("restoration-cancelled"); };
    cancelled();
    if (qualification) await verify(current);
    await recheckOwnership(); cancelled();
    // Exclusive link is the publication CAS: a concurrent or uncertain receipt
    // is preserved, never overwritten. No await separates each final check/link.
    const staging = `${path}.${randomUUID()}.tmp`, bytes = Buffer.from(`${JSON.stringify({ ...receipt, publication: "prepared", physicallyRestored: false })}\n`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    cancelled(); current?.assertModeldAbsent(); recheck();
    linkSync(staging, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!restorationSnapshot(path).bytes?.equals(bytes)) throw new Error("restoration-readback-unproven");
    await verify(current);
    // Preparation, durable pending receipt, readback and final proof all precede
    // the sole completion commit. A crash before this link remains unknown.
    const completionPath = `${path}.complete.json`, completionStaging = `${completionPath}.${randomUUID()}.tmp`;
    const completed = Buffer.from(`${JSON.stringify({ version: 2, operationId: input.operationId, publication: "complete", receiptSha256: sha256Bytes(bytes) })}\n`);
    const completeFd = openSync(completionStaging, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(completeFd, completed); fsyncSync(completeFd);
      const readBack = Buffer.alloc(completed.length);
      if (readSync(completeFd, readBack, 0, readBack.length, 0) !== completed.length || !readBack.equals(completed)) throw Error("restoration-completion-unproven");
    } finally { closeSync(completeFd); }
    await verify(current);
    await recheckOwnership();
    cancelled(); current?.assertModeldAbsent(); recheck();
    validateCompletedRestoration(JSON.parse(bytes.toString()), JSON.parse(completed.toString()), input.operationId, sha256Bytes(bytes));
    // No fallible post-publication work can relabel an incomplete proof as complete.
    linkSync(completionStaging, completionPath);
    return receipt;
  } };
}

/** Read a historical receipt only. No process observation, gate acquisition,
 * mutation, adoption admission or renewal of the recorded physical proof. */
export function readOriginalRestoration(root: string, operationId: string): RestorationReceipt | null {
  return readCompletedRestoration(root, operationId);
}
