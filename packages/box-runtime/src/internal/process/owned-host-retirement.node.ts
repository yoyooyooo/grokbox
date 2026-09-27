import { constants, openSync, closeSync, fsyncSync, writeFileSync, linkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseConfigJson, runtimeDesiredFromConfig } from "@grokbox/runtime-kernel/config";
import { prepareFailedAdoptionEvidence, restorationSnapshot, type RestorationInput } from "./adopt-restoration.ts";
import { proveStableOfficialState } from "./official-chain.ts";
import { pinOwnedHost, type HostSignalHandle, type RetirementTarget } from "./owned-host-handle.node.ts";

export type HostRetirementReceipt = {
  operationId: string; target: { pid: number; start: number };
  state: "previous-attempt" | "exit-observed" | "exit-unproven";
  signaled: boolean | "unknown"; attemptSha256: string; reason?: string;
};
export type HostRetirementPorts = {
  bootId: () => string;
  assertModeldAbsent: () => void;
  recheckOwnership: () => Promise<void>;
  observeIdle: (pid: number, signal: AbortSignal) => Promise<unknown>;
  pin?: (target: RetirementTarget, signal: AbortSignal) => Promise<HostSignalHandle>;
};

function publishOnce(path: string, value: unknown): string {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  if (bytes.length > 8192) throw Error("retirement-record-too-large");
  const staging = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); linkSync(staging, path); fsyncSync(directory); } finally { closeSync(directory); }
  return sha256Text(bytes.toString());
}

/** Recovery holds controller, identity and modeld service gates through the
 * joined handle. The original operation/evidence is never rewritten. */
export async function retireFailedAdoptionHost(input: RestorationInput & {
  boxRoot: string; retirement: HostRetirementPorts; signal: AbortSignal;
}): Promise<HostRetirementReceipt> {
  if (input.qualificationPath) throw Error("retirement-current-scope-not-supported");
  input.signal.throwIfAborted();
  const proof = prepareFailedAdoptionEvidence(input);
  const { creation, original, ports, sources } = proof;
  if (!creation?.launch || original.state !== "unknown" || original.leaseOwner?.bootId !== input.retirement.bootId())
    throw Error("retirement-original-owner-unproven");
  const config = restorationSnapshot(join(input.boxRoot, "config.json"));
  if (runtimeDesiredFromConfig(parseConfigJson(config.bytes!.toString())).mode !== "disabled") throw Error("retirement-routing-not-disabled");
  sources.push(config);
  const directory = dirname(join(input.runRoot, "state", "adoptions", input.operationId, "journal.json"));
  const path = join(directory, "host-retirement.attempt.json");
  const prior = restorationSnapshot(path, true);
  if (prior.bytes) {
    const value = JSON.parse(prior.bytes.toString());
    if (value.version !== 1 || value.operationId !== input.operationId || !isDeepStrictEqual(value.target, creation.host))
      throw Error("retirement-original-attempt-unproven");
    return { operationId: input.operationId, target: creation.host, state: "previous-attempt", signaled: false, attemptSha256: prior.sha256! };
  }
  const wrapperProof = proof.original.prefix.diagnostic.signals?.filter((row: { signal: string; sent: boolean }) => row.signal === "SIGSTOP" && row.sent);
  if (wrapperProof?.length !== 1) throw Error("retirement-wrapper-unproven");
  const observe = () => {
    input.retirement.assertModeldAbsent();
    const rows = ports.processes.list();
    if (rows.some(row => ["temp-supervisor", "guardian"].includes(ports.classify(row) ?? "")
      || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg)))) throw Error("retirement-owner-present");
    for (const owner of proof.owned) {
      if (owner.pid === creation.host.pid && owner.start === creation.host.start) continue;
      const current = ports.processes.inspectLifetime?.(owner.pid) ?? ports.processes.inspect(owner.pid);
      if (current?.start === owner.start) throw Error("retirement-owner-present");
    }
    const found = proveStableOfficialState({ ...ports.processes, list: () => rows }, ports.classify,
      { gatewayPid: ports.gatewayPid() });
    if (!found.ok || found.chain.host.pid !== creation.host.pid || found.chain.host.start !== creation.host.start
      || found.chain.wrapper.pid !== wrapperProof[0].pid || found.chain.wrapper.start !== wrapperProof[0].start)
      throw Error("retirement-chain-unproven");
    for (const identity of Object.values(found.chain)) {
      if (identity.uid !== original.leaseOwner.uid || !isDeepStrictEqual(ports.processes.inspect(identity.pid), identity))
        throw Error("retirement-identity-changed");
    }
    if (!ports.hasRelevantPreload(found.chain.host.pid) || ports.hasRelevantPreload(found.chain.wrapper.pid)
      || ports.hasRelevantPreload(found.chain.supervisor.pid)) throw Error("retirement-preload-unproven");
    const host = found.chain.host;
    if (sha256Text(host.exe) !== creation.launch!.exeDigest || sha256Text(JSON.stringify(host.cmdline)) !== creation.launch!.argvDigest)
      throw Error("retirement-launch-changed");
    return found.chain;
  };
  const chain = structuredClone(observe());
  const recheck = () => {
    input.signal.throwIfAborted();
    for (const source of sources) {
      const current = restorationSnapshot(source.path, source.bytes === null);
      if (current.sha256 !== source.sha256 || !isDeepStrictEqual(current.identity, source.identity)) throw Error("retirement-evidence-changed");
    }
    if (!isDeepStrictEqual(observe(), chain)) throw Error("retirement-chain-changed");
  };
  const target: RetirementTarget = { ...creation.host, ...creation.launch, operationId: input.operationId };
  const handle = await (input.retirement.pin ?? pinOwnedHost)(target, input.signal);
  try {
    await input.retirement.observeIdle(target.pid, input.signal);
    await input.retirement.recheckOwnership();
    recheck();
    const attemptSha256 = publishOnce(path, { version: 1, operationId: input.operationId,
      target: creation.host, evidence: proof.evidence, configSha256: config.sha256, signal: "SIGTERM", at: new Date().toISOString() });
    let requested = false;
    let receipt: HostRetirementReceipt;
    try {
      // A changed snapshot consumes the recorded intent but sends no signal.
      await input.retirement.recheckOwnership();
      recheck(); requested = true;
      const result = await handle.terminate();
      receipt = { operationId: input.operationId, target: creation.host,
        state: result.exitObserved ? "exit-observed" : "exit-unproven",
        signaled: result.signaled ? true : "unknown", attemptSha256 };
    } catch {
      receipt = { operationId: input.operationId, target: creation.host, state: "exit-unproven",
        signaled: requested ? "unknown" : false, attemptSha256, reason: "retirement-interrupted" };
    }
    try {
      await input.retirement.recheckOwnership();
      input.retirement.assertModeldAbsent();
      publishOnce(join(directory, "host-retirement.result.json"), { version: 1, ...receipt });
    }
    catch { receipt = { ...receipt, state: "exit-unproven", reason: "retirement-result-unpublished" }; }
    return receipt;
  } finally { await handle.close(); }
}
