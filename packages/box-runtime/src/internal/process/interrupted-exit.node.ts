import { constants, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, mkdirSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseAdoptionOwner } from "./adopt-evidence.ts";
import { restorationSnapshot, restorationOperationId, isLifetime, RESTORATION_ARTIFACT_MAX_BYTES, OFFICIAL_EXIT_ROLES, officialExitCompletionPath,
  officialExitEvidencePaths, readOfficialExit, validateOfficialExit, type OfficialExitReceipt, type OfficialExitPreserved } from "./restoration-proof.ts";
import { proveStableOfficialState } from "./official-chain.ts";
import { stableIdentitiesMatch, identitiesMatch } from "./process-port.ts";
import type { RestorationPorts } from "./adopt-restoration.ts";

const fail = (reason: string): never => { throw Error(`restoration-exit-${reason}`); };
const parse = (raw: string | null) => raw === null ? null : JSON.parse(raw);

/** Both existing recovery gates must be held by the caller. This case begins
 * AFTER a completed adoption: its exact Host is gone, but interrupted official
 * exit left the journal pending. No journal, attestation or unknown is changed. */
export function prepareOfficialExit(input: {
  operationId: string; runRoot: string; storePath: string; expectedOperation: unknown; ports: RestorationPorts;
}) {
  const id = restorationOperationId(input.operationId);
  const named = { ...officialExitEvidencePaths(input.runRoot, id), operations: input.storePath };
  const ownerFile = restorationSnapshot(named.owner, true);
  if (!ownerFile.bytes) return null;
  const owner = parseAdoptionOwner(JSON.parse(ownerFile.bytes.toString()));
  if (owner.state !== "complete") return null;
  const files = OFFICIAL_EXIT_ROLES.map(role => ({ role, ...restorationSnapshot(named[role], role === "attestation") }));
  if (files.some(f => f.identity && (f.identity[5]! & 0o077) !== 0)) fail("evidence-unprotected");
  const preserved = Object.fromEntries(files.map(f => [f.role, f.bytes?.toString("utf8") ?? null])) as OfficialExitPreserved;
  const original = parse(preserved.operations)?.[id], journal = parse(preserved.journal), archived = parse(preserved.archivedJournal);
  if (owner.operationId !== id || original?.state !== "unknown" || !isDeepStrictEqual(original, input.expectedOperation)
    || journal.phase !== "deactivate-term" || journal.launchMode !== "transient-adopt" || journal.tempSupervisor !== null
    || archived.operationId !== id || archived.phase !== "attested" || archived.tempSupervisor !== null
    || owner.journalSha256 !== files.find(f => f.role === "archivedJournal")!.sha256
    || !isDeepStrictEqual(journal.host, archived.host) || !isDeepStrictEqual(journal.adoptingSupervisor, archived.adoptingSupervisor)
    || !isLifetime(journal.host) || !isLifetime(journal.adoptingSupervisor)) fail("original-unproven");
  const attestation = parse(preserved.attestation);
  if (preserved.attestation !== null && (!attestation || attestation.operationId !== id || !stableIdentitiesMatch(journal.host, attestation.identity))) fail("attestation-conflict");
  if (restorationSnapshot(officialExitCompletionPath(input.runRoot, id), true).bytes) fail("already-recorded");
  const inspect = () => {
    const { ports } = input;
    const old = ports.processes.inspectLifetime ? ports.processes.inspectLifetime(journal.host.pid) : ports.processes.inspect(journal.host.pid);
    if (old && (!isLifetime(old) || old.pid !== journal.host.pid)) fail("old-host-unreadable");
    if (old && old.start === journal.host.start) fail("old-host-present");
    const rows = ports.processes.list();
    if (rows.some(row => ["temp-supervisor", "guardian"].includes(ports.classify(row) ?? "")
      || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg)))) fail("helper-present");
    const gatewayPid = ports.gatewayPid();
    const official = proveStableOfficialState({ ...ports.processes, list: () => rows }, ports.classify, { gatewayPid });
    if (!official.ok || official.mode !== "direct-launch") return fail("official-chain-unproven");
    const { host, supervisor } = official.chain;
    if (!stableIdentitiesMatch(journal.adoptingSupervisor, supervisor)
      || Object.values(official.chain).some(identity => !identitiesMatch(identity, ports.processes.inspect(identity.pid)))
      || ports.hasRelevantPreload(host.pid) || ports.hasRelevantPreload(supervisor.pid)
      || gatewayPid !== host.pid || ports.gatewayPid() !== host.pid) fail("official-chain-unproven");
    ports.processes.recheckDiscovery?.();
    return { chain: official.chain, gatewayPid: host.pid };
  };
  const observed = inspect();
  const stable = () => {
    for (const file of files) {
      const now = restorationSnapshot(file.path, file.role === "attestation");
      if (now.sha256 !== file.sha256 || !isDeepStrictEqual(now.identity, file.identity)) fail("evidence-changed");
    }
    if (!isDeepStrictEqual(inspect(), observed)) fail("generation-changed");
  };
  const receipt: OfficialExitReceipt = { version: 1, operationId: id, kind: "interrupted-official-exit",
    physicallyRestored: true, adopted: false, replayAuthorized: false, observedAt: new Date().toISOString(),
    oldHost: { pid: journal.host.pid, start: journal.host.start },
    chain: Object.fromEntries(Object.entries(observed.chain).map(([role, value]) => [role,
      { pid: value.pid, start: value.start, uid: value.uid, ppid: value.ppid }])), gatewayPid: observed.gatewayPid,
    evidence: Object.fromEntries(files.map(f => [f.role, f.sha256])) as OfficialExitReceipt["evidence"] };
  return { receipt, publish(signal?: AbortSignal) {
    if (signal?.aborted) fail("cancelled");
    stable();
    const body = { receipt, preserved }, envelope = { version: 1, ...body, checksum: sha256Text(canonicalJson(body)) };
    validateOfficialExit(envelope, id);
    const data = Buffer.from(JSON.stringify(envelope) + "\n");
    if (data.length > RESTORATION_ARTIFACT_MAX_BYTES) fail("receipt-too-large");
    const destination = officialExitCompletionPath(input.runRoot, id), directory = join(input.runRoot, "state/adoptions", id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(temporary).equals(data)) fail("readback");
    if (signal?.aborted) fail("cancelled");
    stable();
    linkSync(temporary, destination);
    const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    const readback = readOfficialExit(input.runRoot, id, true);
    if (!readback) return fail("readback");
    return readback;
  } };
}
