import { adoptionEvidencePath, adoptionOwnerPath } from "./adopt-evidence.ts";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, linkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { attestationPath } from "../io/authority.node.ts";
import { adoptOpStatePath, parseAdoptOpState } from "./transient-adopt.ts";
import { findUniqueOfficialChain, type RoleClassifier } from "./official-chain.ts";
import type { ProcessPort } from "./process-port.ts";

/** Strict byte snapshot. Missing optional evidence is itself frozen; unreadable is never absent. */
export function restorationSnapshot(path: string, optional = false) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return { path, bytes: null, sha256: null, identity: null };
    throw new Error("restoration-evidence-unavailable");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > 4 * 1024 * 1024) throw new Error();
    const bytes = Buffer.alloc(before.size + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    const pathInfo = lstatSync(path);
    if (length !== before.size || pathInfo.isSymbolicLink() || !isDeepStrictEqual(identity(before), identity(fstatSync(fd)))
      || !isDeepStrictEqual(identity(before), identity(pathInfo))) throw new Error();
    return { path, bytes: bytes.subarray(0, length), sha256: sha256Bytes(bytes.subarray(0, length)), identity: identity(before) };
  } catch { throw new Error("restoration-evidence-unavailable"); }
  finally { closeSync(fd); }
}

export type RestorationPorts = {
  processes: ProcessPort;
  classify: RoleClassifier;
  gatewayPid: () => number | null;
  /** Must throw on unavailable evidence, not return false. */
  hasRelevantPreload: (pid: number) => boolean;
};

export const restorationReceiptPath = (root: string, operationId: string) => join(root, "state", `adopt-restoration-${operationId}.json`);

/** Called only by the recovery owner while BOTH physical gates are held. This
 * publishes observation of restoration, never edits the failed operation. */
export function prepareOriginalRestoration(input: {
  operationId: string; runRoot: string; storePath: string; expectedOperation: unknown; ports: RestorationPorts;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.operationId)) throw new Error("restoration-operation-invalid");
  const { ports } = input;
  const sources = [restorationSnapshot(input.storePath), restorationSnapshot(adoptOpStatePath(input.runRoot)),
    restorationSnapshot(join(input.runRoot, "state", "preload-marker.json")), restorationSnapshot(attestationPath(input.runRoot), true)];
  const operations = JSON.parse(sources[0]!.bytes!.toString());
  if (!isDeepStrictEqual(operations[input.operationId], input.expectedOperation)) throw new Error("restoration-operation-changed");
  const journal = parseAdoptOpState(JSON.parse(sources[1]!.bytes!.toString()));
  const marker = JSON.parse(sources[2]!.bytes!.toString());
  const archivedJournal = restorationSnapshot(adoptionEvidencePath(input.runRoot, input.operationId, "journal"));
  const archivedMarker = restorationSnapshot(adoptionEvidencePath(input.runRoot, input.operationId, "marker"));
  if (archivedJournal.sha256 !== sources[1]!.sha256 || archivedMarker.sha256 !== sources[2]!.sha256) throw Error("restoration-original-evidence-changed");
  const ownerClaim = restorationSnapshot(adoptionOwnerPath(input.runRoot));
  const claim = JSON.parse(ownerClaim.bytes!.toString());
  if (claim.version !== 1 || claim.operationId !== input.operationId || claim.state !== "unresolved") throw Error("restoration-owner-claim-unproven");
  sources.push(archivedJournal, archivedMarker, ownerClaim);
  const original = operations[input.operationId], diagnostic = original?.prefix?.diagnostic;
  const creation = journal.creation;
  const identity = (row: unknown): row is { pid: number; start: number } & Record<string, unknown> => !!row && typeof row === "object"
    && Number.isSafeInteger((row as any).pid) && (row as any).pid > 0 && Number.isSafeInteger((row as any).start) && (row as any).start > 0;
  const same = (a: { pid: number; start: number }, b: { pid: number; start: number }) => a.pid === b.pid && a.start === b.start;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  // Legacy compilation alone is not a complete creation/ownership receipt.
  if (!creation || creation.version !== 1 || creation.operationId !== input.operationId || !diagnostic || !journal.failure
    || !isDeepStrictEqual(diagnostic, journal.failure) || ![creation.host, creation.tempSupervisor, creation.guardian, creation.holder].every(identity)
    || new Set([creation.host.pid, creation.tempSupervisor.pid, creation.guardian.pid, creation.holder.pid]).size !== 4
    || !creation.compile || typeof creation.compile.profileId !== "string" || !creation.compile.profileId.length || creation.compile.profileId.length > 128
    || ![creation.compile.profileSha256, creation.compile.sourceSha256, creation.compile.transformedSha256, creation.preloadSha256].every(hash)
    || !isDeepStrictEqual(marker.compile, creation.compile) || marker.preloadSha256 !== creation.preloadSha256
    || !identity(marker) || !same(marker, creation.host)
    || !identity(diagnostic.child) || !same(diagnostic.child, creation.host)
    || journal.tempSupervisor && !same(journal.tempSupervisor, creation.tempSupervisor)
    || journal.host && !same(journal.host, creation.host)) throw Error("restoration-creation-provenance-unavailable");
  const cleanup = diagnostic.cleanup ?? [];
  if (!Array.isArray(cleanup) || cleanup.some((row: { role: string; pid: number; start: number }) => !identity(row)
    || !["host", "temp-supervisor"].includes(row.role) || !same(row, row.role === "host" ? creation.host : creation.tempSupervisor))) throw Error("restoration-owner-provenance-conflict");
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
  const owned = [creation.tempSupervisor, creation.host, creation.guardian, creation.holder, diagnostic.child, ...cleanup];
  const observe = () => {
    const rows = ports.processes.list();
    for (const row of rows) {
      const role = ports.classify(row);
      if (role === "temp-supervisor" || role === "guardian" || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg))) {
        throw new Error("restoration-owner-present");
      }
    }
    for (const owner of owned) {
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
  const receipt = {
    version: 1, operationId: input.operationId, physicallyRestored: true, adopted: false, replayAuthorized: false,
    evidence: { ownerClaim: ownerClaim.sha256, operations: sources[0]!.sha256, journal: sources[1]!.sha256, marker: sources[2]!.sha256, attestation: sources[3]!.sha256 },
    chain: Object.fromEntries(Object.entries(chain).map(([role, row]) => [role, { pid: row.pid, start: row.start, uid: row.uid, ppid: row.ppid }])),
    gatewayPid: chain.host.pid,
  };
  const path = restorationReceiptPath(input.runRoot, input.operationId);
  return { receipt, publish: () => {
    // Exclusive link is the publication CAS: a concurrent or uncertain receipt
    // is preserved, never overwritten. All awaits precede this synchronous boundary.
    const staging = `${path}.${randomUUID()}.tmp`, bytes = Buffer.from(`${JSON.stringify({ ...receipt, publication: "prepared", physicallyRestored: false })}\n`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    recheck();
    linkSync(staging, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!restorationSnapshot(path).bytes?.equals(bytes)) throw new Error("restoration-readback-unproven");
    recheck();
    // Preparation, durable pending receipt, readback and final proof all precede
    // the sole completion commit. A crash before this link remains unknown.
    const completionPath = `${path}.complete.json`, completionStaging = `${completionPath}.${randomUUID()}.tmp`;
    const completed = Buffer.from(`${JSON.stringify({ version: 1, operationId: input.operationId, publication: "complete", receiptSha256: sha256Bytes(bytes) })}\n`);
    const completeFd = openSync(completionStaging, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(completeFd, completed); fsyncSync(completeFd);
      const readBack = Buffer.alloc(completed.length);
      if (readSync(completeFd, readBack, 0, readBack.length, 0) !== completed.length || !readBack.equals(completed)) throw Error("restoration-completion-unproven");
    } finally { closeSync(completeFd); }
    recheck();
    // No fallible post-publication work can relabel an incomplete proof as complete.
    linkSync(completionStaging, completionPath);
    return receipt;
  } };
}

/** Read a historical receipt only. No process observation, gate acquisition,
 * mutation, adoption admission or renewal of the recorded physical proof. */
export function readOriginalRestoration(root: string, operationId: string): ReturnType<typeof prepareOriginalRestoration>["receipt"] | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId)) throw new Error("restoration-operation-invalid");
  const snapshot = restorationSnapshot(restorationReceiptPath(root, operationId), true);
  if (!snapshot.bytes) return null;
  if (snapshot.bytes.length > 4096) throw new Error("restoration-receipt-invalid");
  const row = JSON.parse(snapshot.bytes.toString());
  const completion = restorationSnapshot(`${snapshot.path}.complete.json`, true);
  if (!completion.bytes || completion.bytes.length > 1024) throw Error("restoration-publication-incomplete");
  const committed = JSON.parse(completion.bytes.toString());
  if (committed.version !== 1 || committed.operationId !== operationId || committed.publication !== "complete"
    || committed.receiptSha256 !== snapshot.sha256) throw Error("restoration-publication-incomplete");
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const natural = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!row || row.version !== 1 || row.operationId !== operationId || row.physicallyRestored !== false || row.publication !== "prepared"
    || row.adopted !== false || row.replayAuthorized !== false || !row.evidence || !row.chain
    || !hash(row.evidence.ownerClaim) || !hash(row.evidence.operations) || !hash(row.evidence.journal) || !hash(row.evidence.marker)
    || !(row.evidence.attestation === null || hash(row.evidence.attestation))) throw new Error("restoration-receipt-invalid");
  const chain: ReturnType<typeof prepareOriginalRestoration>["receipt"]["chain"] = {};
  for (const role of ["wrapper", "supervisor", "host"]) {
    const identity = row.chain[role];
    if (!identity || !natural(identity.pid) || identity.pid === 0 || !natural(identity.start)
      || !natural(identity.uid) || !natural(identity.ppid)) throw new Error("restoration-receipt-invalid");
    chain[role] = { pid: identity.pid, start: identity.start, uid: identity.uid, ppid: identity.ppid };
  }
  if (row.gatewayPid !== chain.host!.pid || chain.host!.ppid !== chain.supervisor!.pid
    || chain.supervisor!.ppid !== chain.wrapper!.pid) throw new Error("restoration-receipt-invalid");
  return { version: 1, operationId, physicallyRestored: true, adopted: false, replayAuthorized: false,
    evidence: { ownerClaim: row.evidence.ownerClaim, operations: row.evidence.operations, journal: row.evidence.journal, marker: row.evidence.marker, attestation: row.evidence.attestation },
    chain, gatewayPid: row.gatewayPid };
}
