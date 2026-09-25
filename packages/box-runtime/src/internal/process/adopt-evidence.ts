import { mkdirSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, constants, fstatSync, lstatSync, readSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { writeRuntimeArtifact } from "../io/artifacts.node.ts";
import { readCompletedRestoration } from "./restoration-proof.ts";

function readEvidence(path: string, optional = false): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > 4 * 1024 * 1024) throw Error("adoption-evidence-invalid");
    const bytes = Buffer.alloc(before.size + 1), length = readSync(fd, bytes, 0, bytes.length, 0), current = lstatSync(path), after = fstatSync(fd);
    if (length !== before.size || current.isSymbolicLink() || [current, after].some(row => row.dev !== before.dev || row.ino !== before.ino
      || row.size !== before.size || row.mtimeMs !== before.mtimeMs || row.ctimeMs !== before.ctimeMs)) throw Error("adoption-evidence-changed");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export type CreatedIdentity = { pid: number; start: number };
export type AdoptLaunch = { rootDigest: string; targetDigest: string; exeDigest: string; argvDigest: string; uid: number; mode: "identity" | "route" };
export function parseAdoptLaunch(value: unknown): AdoptLaunch {
  const row = value as AdoptLaunch | null;
  if (!row || typeof row !== "object" || Object.keys(row).length !== 6 || !Number.isSafeInteger(row.uid) || row.uid < 0
    || !["identity", "route"].includes(row.mode) || ![row.rootDigest, row.targetDigest, row.exeDigest, row.argvDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw Error("adoption-launch-invalid");
  return { rootDigest: row.rootDigest, targetDigest: row.targetDigest, exeDigest: row.exeDigest, argvDigest: row.argvDigest, uid: row.uid, mode: row.mode };
}
export type AdoptCreation = {
  version: 1; operationId: string;
  tempSupervisor: CreatedIdentity; host: CreatedIdentity;
  guardian: CreatedIdentity; holder: CreatedIdentity;
  compile: import("../host/compile-receipt.ts").CompileReceipt;
  preloadSha256: string;
  launch?: AdoptLaunch;
};
export function adoptionEvidencePath(root: string, id: string, name: "journal" | "marker"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw Error("invalid-operation-id");
  return join(root, "state", "adoptions", id, `${name}.json`);
}
export const adoptionOwnerPath = (root: string) => join(root, "state", "adoption-owner.json");
export type AdoptionOwner = { version: 1; operationId: string } &
  ({ state: "unresolved" } | { state: "complete"; journalSha256: string });
export function parseAdoptionOwner(value: unknown): AdoptionOwner {
  const row = value as Partial<AdoptionOwner> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.version !== 1 || typeof row.operationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.operationId)
    || !["unresolved", "complete"].includes(row.state ?? "")
    || Object.keys(row).length !== (row.state === "complete" ? 4 : 3)
    || row.state === "complete" && (typeof row.journalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.journalSha256))) throw Error("adoption-owner-invalid");
  return row as AdoptionOwner;
}
export async function writeAdoptionOwner(root: string, operationId: string, state: "unresolved" | "complete", guard?: () => void) {
  let journalSha256: string | undefined;
  if (state === "complete") {
    const bytes = readEvidence(join(root, "state", "adopt-op.json"))!, journal = JSON.parse(bytes.toString());
    if (journal.operationId !== operationId || journal.phase !== "attested" || journal.tempSupervisor !== null
      || !readEvidence(adoptionEvidencePath(root, operationId, "journal"))!.equals(bytes)) throw Error("adoption-completion-unproven");
    journalSha256 = sha256Bytes(bytes);
  }
  await writeRuntimeArtifact(adoptionOwnerPath(root), parseAdoptionOwner({ version: 1, operationId, state, ...(journalSha256 ? { journalSha256 } : {}) }), guard);
}

/** Current physical resource boundary, not a ban on historical unknown rows.
 * Only a completed original restoration proof may discharge unresolved ownership. */
export function unresolvedAdoption(root: string): string | null {
  let owner: { version?: number; operationId?: string; state?: string; journalSha256?: string } | null = null;
  const path = adoptionOwnerPath(root), journalPath = join(root, "state", "adopt-op.json");
  try {
    const ownerBytes = readEvidence(path, true);
    if (ownerBytes) { owner = parseAdoptionOwner(JSON.parse(ownerBytes.toString())); }
    if (owner?.state === "complete") {
      if (!owner.operationId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner.operationId)) return "unresolved";
      const journalBytes = readEvidence(journalPath)!, journal = JSON.parse(journalBytes.toString());
      if (journal.phase === "direct-official" && !journal.tempSupervisor) return null;
      if (journal.operationId === owner.operationId && journal.phase === "attested" && !journal.tempSupervisor
        && owner.journalSha256 === sha256Bytes(journalBytes)
        && readEvidence(adoptionEvidencePath(root, owner.operationId, "journal"))!.equals(journalBytes)) return null;
      return owner.operationId;
    }
    const journalBytes = readEvidence(journalPath, true);
    if (!owner && journalBytes) {
      const journal = JSON.parse(journalBytes.toString());
      if (["attested", "direct-official"].includes(journal.phase) && !journal.tempSupervisor) return null;
      owner = journal;
    }
    if (!owner) return null;
    if (!owner.operationId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner.operationId)) return "unresolved";
    if (!readCompletedRestoration(root, owner.operationId, true)) return owner.operationId;
    return null;
  } catch { return owner?.operationId ?? "unresolved"; }
}

/** First matching marker bytes are immutable evidence; never borrow a later generation. */
export function preserveAdoptionMarker(root: string, id: string, source: string): void {
  const bytes = readEvidence(source)!;
  if (bytes.length > 16384 || JSON.parse(bytes.toString()).operationId !== id) throw Error("marker-provenance-unavailable");
  const path = adoptionEvidencePath(root, id, "marker");
  const prior = readEvidence(path, true);
  if (prior) {
    if (!prior.equals(bytes)) throw Error("marker-evidence-changed");
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  linkSync(temporary, path);
}
