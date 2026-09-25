import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";

export type Lifetime = { pid: number; start: number };
export type OriginalEvidence = { operations: string; journal: string; marker: string; attestation: string | null;
  ownerClaim: string | null; archivedJournal: string | null; archivedMarker: string | null };
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isLifetime = (value: unknown): value is Lifetime => !!value && typeof value === "object"
  && Number.isSafeInteger((value as Lifetime).pid) && (value as Lifetime).pid > 0
  && Number.isSafeInteger((value as Lifetime).start) && (value as Lifetime).start > 0;
export const sameLifetime = (a: Lifetime, b: Lifetime) => a.pid === b.pid && a.start === b.start;
export function restorationOperationId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw Error("restoration-operation-invalid");
  return id;
}
export const restorationReceiptPath = (root: string, id: string) => join(root, "state", `adopt-restoration-${restorationOperationId(id)}.json`);
export const restorationCompletionPath = (root: string, id: string) => `${restorationReceiptPath(root, id)}.complete.json`;

/** Missing optional bytes are a fact. EACCES, symlinks and changed files are not absence. */
export function restorationSnapshot(path: string, optional = false) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return { path, bytes: null, sha256: null, identity: null };
    throw Error("restoration-evidence-unavailable");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > 4 * 1024 * 1024) throw Error();
    const bytes = Buffer.alloc(before.size + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode];
    const named = lstatSync(path);
    if (length !== before.size || named.isSymbolicLink() || !isDeepStrictEqual(identity(before), identity(fstatSync(fd)))
      || !isDeepStrictEqual(identity(before), identity(named))) throw Error();
    return { path, bytes: bytes.subarray(0, length), sha256: sha256Bytes(bytes.subarray(0, length)), identity: identity(before) };
  } catch { throw Error("restoration-evidence-unavailable"); }
  finally { closeSync(fd); }
}

export type RestorationReceipt = {
  version: 3; operationId: string; physicallyRestored: true; adopted: false; replayAuthorized: false;
  priorPreparationSha256: string | null;
  evidence: OriginalEvidence;
  proof: { kind: "exact-lifetime-absence" | "qualified-modeld-absent-retirement"; observedAt: string;
    qualificationSha256: string | null; observationSha256: string | null };
  chain: Record<string, Lifetime & { uid: number; ppid: number }>; gatewayPid: number;
};

/** One completed negative-proof parser for historical inspection and the resource fence.
 * This receipt is never an adoption completion claim or permission to replay. */
export function readCompletedRestoration(root: string, id: string, currentEvidence = false): RestorationReceipt | null {
  const snapshot = restorationSnapshot(restorationCompletionPath(root, id), true);
  if (!snapshot.bytes) return null;
  const receipt = validateCompletedRestoration(JSON.parse(snapshot.bytes.toString()), id);
  const e = receipt.evidence;
  if (currentEvidence) {
    const paths = { journal: join(root, "state", "adopt-op.json"), marker: join(root, "state", "preload-marker.json"),
      ownerClaim: join(root, "state", "adoption-owner.json"), attestation: join(root, "attestation.json"),
      archivedJournal: join(root, "state", "adoptions", id, "journal.json"), archivedMarker: join(root, "state", "adoptions", id, "marker.json") };
    for (const [key, path] of Object.entries(paths)) {
      if (restorationSnapshot(path, e[key as keyof OriginalEvidence] === null).sha256 !== e[key as keyof OriginalEvidence]) throw Error("restoration-evidence-conflict");
    }
    if (restorationSnapshot(restorationReceiptPath(root, id), receipt.priorPreparationSha256 === null).sha256 !== receipt.priorPreparationSha256) throw Error("restoration-evidence-conflict");
  }
  return receipt;
}

export function validateCompletedRestoration(completed: any, id: string): RestorationReceipt {
  const row = completed?.receipt;
  const keys = (value: unknown, expected: string[]) => !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === expected.sort().join(",");
  if (!keys(completed, ["version", "operationId", "publication", "receiptSha256", "receipt"])
    || !keys(row, ["version", "operationId", "physicallyRestored", "adopted", "replayAuthorized", "priorPreparationSha256", "evidence", "proof", "chain", "gatewayPid"])
    || !keys(row.evidence, ["operations", "journal", "marker", "attestation", "ownerClaim", "archivedJournal", "archivedMarker"])
    || !keys(row.proof, ["kind", "observedAt", "qualificationSha256", "observationSha256"])
    || !keys(row.chain, ["wrapper", "supervisor", "host"])) throw Error("restoration-receipt-invalid");
  if (completed.version !== 3 || completed.operationId !== id || completed.publication !== "complete"
    || completed.receiptSha256 !== sha256Text(canonicalJson(row))) throw Error("restoration-publication-incomplete");
  const e = row?.evidence, proof = row?.proof;
  if (row?.version !== 3 || row.operationId !== id || row.physicallyRestored !== true
    || !(row.priorPreparationSha256 === null || isDigest(row.priorPreparationSha256))
    || row.adopted !== false || row.replayAuthorized !== false || !e || !proof || !row.chain
    || ![e.operations, e.journal, e.marker].every(isDigest)
    || ![e.attestation, e.ownerClaim, e.archivedJournal, e.archivedMarker].every(value => value === null || isDigest(value))
    || !["exact-lifetime-absence", "qualified-modeld-absent-retirement"].includes(proof.kind)
    || typeof proof.observedAt !== "string" || proof.observedAt.length > 32 || !Number.isFinite(Date.parse(proof.observedAt))
    || (proof.kind === "exact-lifetime-absence" ? proof.qualificationSha256 !== null || proof.observationSha256 !== null
      : !isDigest(proof.qualificationSha256) || !isDigest(proof.observationSha256))) throw Error("restoration-receipt-invalid");
  const chain: RestorationReceipt["chain"] = {};
  for (const role of ["wrapper", "supervisor", "host"]) {
    const identity = row.chain[role] as Lifetime & { uid: number; ppid: number };
    if (!keys(identity, ["pid", "start", "uid", "ppid"]) || !isLifetime(identity) || !Number.isSafeInteger(identity.uid) || identity.uid < 0
      || !Number.isSafeInteger(identity.ppid) || identity.ppid < 0) throw Error("restoration-receipt-invalid");
    chain[role] = { pid: identity.pid, start: identity.start, uid: identity.uid, ppid: identity.ppid };
  }
  if (row.gatewayPid !== chain.host!.pid || chain.host!.ppid !== chain.supervisor!.pid
    || chain.supervisor!.ppid !== chain.wrapper!.pid) throw Error("restoration-receipt-invalid");
  return { version: 3, operationId: id, physicallyRestored: true, adopted: false, replayAuthorized: false,
    priorPreparationSha256: row.priorPreparationSha256, evidence: e, proof, chain, gatewayPid: row.gatewayPid };
}
