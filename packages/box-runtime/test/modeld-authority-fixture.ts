import { writeAttestation, type RouteAttestation } from "../src/internal/io/authority.node.ts";
import { writeAdoptOpState } from "../src/internal/process/transient-adopt.ts";
import { writeAdoptionOwner } from "../src/internal/process/adopt-evidence.ts";

type CompletedRoute = Omit<RouteAttestation, "launchMode"> & Required<Pick<RouteAttestation, "operationId" | "compile">>;

/** Synthetic completed adoption, published through the production evidence writers. */
export async function writeCompletedRouteFixture(runRoot: string, attestation: CompletedRoute): Promise<void> {
  await writeAttestation(runRoot, { ...attestation, launchMode: "transient-adopt" });
  await writeAdoptOpState(runRoot, {
    launchMode: "transient-adopt", phase: "attested", operationId: attestation.operationId,
    compile: attestation.compile, tempSupervisor: null,
    adoptingSupervisor: { ...attestation.identity, pid: attestation.identity.ppid }, host: attestation.identity,
  });
  await writeAdoptionOwner(runRoot, attestation.operationId, "complete");
}
