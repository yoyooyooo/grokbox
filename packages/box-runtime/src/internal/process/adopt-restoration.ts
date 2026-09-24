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
  const owned = [journal.tempSupervisor, journal.host, { pid: marker.pid, start: marker.start }].filter(row => row != null);
  const observe = () => {
    const rows = ports.processes.list();
    for (const row of rows) {
      const role = ports.classify(row);
      if (role === "temp-supervisor" || role === "guardian" || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg))) {
        throw new Error("restoration-owner-present");
      }
    }
    for (const owner of owned) {
      const current = ports.processes.inspect(owner.pid);
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
    if (!isDeepStrictEqual(observe(), chain)) throw new Error("restoration-chain-changed");
  };
  const receipt = {
    version: 1, operationId: input.operationId, physicallyRestored: true, adopted: false, replayAuthorized: false,
    evidence: { operations: sources[0]!.sha256, journal: sources[1]!.sha256, marker: sources[2]!.sha256, attestation: sources[3]!.sha256 },
    chain: Object.fromEntries(Object.entries(chain).map(([role, row]) => [role, { pid: row.pid, start: row.start, uid: row.uid, ppid: row.ppid }])),
    gatewayPid: chain.host.pid,
  };
  const path = restorationReceiptPath(input.runRoot, input.operationId);
  return { receipt, publish: () => {
    // Exclusive link is the publication CAS: a concurrent or uncertain receipt
    // is preserved, never overwritten. All awaits precede this synchronous boundary.
    const staging = `${path}.${randomUUID()}.tmp`, bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    recheck();
    linkSync(staging, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!restorationSnapshot(path).bytes?.equals(bytes)) throw new Error("restoration-readback-unproven");
    recheck();
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
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const natural = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!row || row.version !== 1 || row.operationId !== operationId || row.physicallyRestored !== true
    || row.adopted !== false || row.replayAuthorized !== false || !row.evidence || !row.chain
    || !hash(row.evidence.operations) || !hash(row.evidence.journal) || !hash(row.evidence.marker)
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
    evidence: { operations: row.evidence.operations, journal: row.evidence.journal, marker: row.evidence.marker, attestation: row.evidence.attestation },
    chain, gatewayPid: row.gatewayPid };
}
