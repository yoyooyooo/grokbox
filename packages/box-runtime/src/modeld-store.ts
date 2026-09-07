import { isDeepStrictEqual } from "node:util";
import { observeAttestation } from "./attestation.ts";
import { bindCompiledHost, stableIdentitySha } from "./modeld-binding.ts";
import type { AdmissionAuthority, ModeldPorts } from "./modeld.ts";
import { desiredPath, modelsPath } from "./paths.ts";
import { parseDesiredFile, parseModelsFile } from "./models.ts";
import { observeJson } from "./observation.ts";
import { adoptOpStatePath, parseAdoptOpState } from "./transient-adopt.ts";

/** File adapter only. The Host hook never constructs these ports or opens config/attestation files. */
export function modeldStorePorts(durableRoot: string, runRoot: string): ModeldPorts {
  const snapshot = async () => ({
    desired: await observeJson(desiredPath(durableRoot), parseDesiredFile),
    attestation: await observeAttestation(runRoot),
    journal: await observeJson(adoptOpStatePath(runRoot), parseAdoptOpState),
  });
  return {
    loadModels: async () => {
      const models = await observeJson(modelsPath(durableRoot), parseModelsFile);
      if (models.state !== "present") throw new Error("models unavailable");
      return models.value;
    },
    authority: async (): Promise<AdmissionAuthority> => {
      const first = await snapshot();
      const next = await snapshot();
      if (!isDeepStrictEqual(first, next)) return { state: "pending" };
      const { desired, attestation, journal } = next;
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
        if (journal.state === "missing" || settling) return { state: "pending" };
        if (journal.state !== "present") return { state: "unavailable" };
        const op = journal.value;
        if (op.phase !== "attested" || op.tempSupervisor !== null || op.operationId !== att.operationId ||
          !isDeepStrictEqual(op.compile, att.compile) || !op.host || stableIdentitySha(op.host) !== stableIdentitySha(att.identity)) {
          return { state: "unavailable" };
        }
      } else if (journal.state !== "missing") return { state: "unavailable" };
      try { return { state: "committed", host: bindCompiledHost(att.identity, att.operationId, att.compile) }; }
      catch { return { state: "unavailable" }; }
    },
  };
}
