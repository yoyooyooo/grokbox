import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { adoptionOwnerPath, adoptionEvidencePath, parseAdoptionOwner } from "../process/adopt-evidence.ts";
import { isDeepStrictEqual } from "node:util";
import { observeAttestation } from "./authority.node.ts";
import { bindCompiledHost, stableIdentitySha, type HostBinding } from "../host/host-binding.ts";
import { runtimeConfigPath } from "./paths.ts";
import { runtimeDesiredFromConfig } from "@grokbox/runtime-kernel/config";
import type { ModelsFile } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "./configuration.node.ts";
import { observeJson, observeText } from "./observation.node.ts";
import { adoptOpStatePath, parseAdoptOpState } from "../process/transient-adopt.ts";

export type AdmissionAuthority =
  | { state: "pending" | "disabled" | "unavailable" }
  | { state: "committed"; host: HostBinding };

export type ModeldPorts = {
  loadModels: () => Promise<ModelsFile>;
  authority: () => Promise<AdmissionAuthority>;
};

/** File adapter only. The Host hook never constructs these ports or opens config/attestation files. */
export function modeldStorePorts(durableRoot: string, runRoot: string): ModeldPorts {
  const journalSnapshot = async (path: string) => {
    const text = await observeText(path);
    if (text.state !== "present") return text;
    try { return { state: "present" as const, value: parseAdoptOpState(JSON.parse(text.value)), digest: sha256Text(text.value) }; }
    catch { return { state: "invalid" as const }; }
  };
  const snapshot = async () => {
    const owner = await observeJson(adoptionOwnerPath(runRoot), parseAdoptionOwner);
    return {
      desired: await observeJson(runtimeConfigPath(durableRoot), runtimeDesiredFromConfig),
      attestation: await observeAttestation(runRoot),
      journal: await journalSnapshot(adoptOpStatePath(runRoot)), owner,
      archived: owner.state === "present" ? await journalSnapshot(adoptionEvidencePath(runRoot, owner.value.operationId, "journal")) : { state: "missing" as const },
    };
  };
  return {
    loadModels: async () => {
      try {
        return await openRuntimeStore(durableRoot).loadModels();
      } catch {
        throw new Error("models unavailable");
      }
    },
    authority: async (): Promise<AdmissionAuthority> => {
      const first = await snapshot();
      const next = await snapshot();
      if (!isDeepStrictEqual(first, next)) return { state: "pending" };
      const { desired, attestation, journal, owner, archived } = next;
      if (desired.state === "missing") return { state: "disabled" };
      if (desired.state !== "present") return { state: "unavailable" };
      if (desired.value.mode !== "route") return { state: "disabled" };
      const settling = journal.state === "present" && journal.value.phase !== "attested" &&
        journal.value.phase !== "direct-official" && journal.value.phase !== "recovery-required";
      if (attestation.state === "missing" && (journal.state === "missing" || settling)) return { state: "pending" };
      if (attestation.state !== "present") return { state: "unavailable" };
      const att = attestation.value;
      if (att.mode !== "route" || !att.modeld || !att.operationId || !att.compile ||
        ![att.compile.profileSha256, att.compile.sourceSha256, att.compile.transformedSha256].every((sha) => /^[a-f0-9]{64}$/.test(sha))) {
        return { state: "unavailable" };
      }
      if (att.launchMode === "transient-adopt") {
        if (owner.state === "missing" || owner.state === "present" && owner.value.state === "unresolved") return { state: "pending" };
        if (owner.state !== "present" || owner.value.state !== "complete" || owner.value.operationId !== att.operationId) return { state: "unavailable" };
        if (journal.state === "missing" || settling) return { state: "pending" };
        if (journal.state !== "present") return { state: "unavailable" };
        if (archived.state !== "present" || archived.digest !== journal.digest || owner.value.journalSha256 !== journal.digest) return { state: "unavailable" };
        const op = journal.value;
        if (op.phase !== "attested" || op.tempSupervisor !== null || op.operationId !== att.operationId ||
          !isDeepStrictEqual(op.compile, att.compile) || !op.host || stableIdentitySha(op.host) !== stableIdentitySha(att.identity)) {
          return { state: "unavailable" };
        }
      } else if (journal.state !== "missing" || owner.state !== "missing") return { state: "unavailable" };
      try { return { state: "committed", host: bindCompiledHost(att.identity, att.operationId, att.compile) }; }
      catch { return { state: "unavailable" }; }
    },
  };
}
