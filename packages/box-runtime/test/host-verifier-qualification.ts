import { Effect, ManagedRuntime } from "effect";
import { HOST_CHECK_REQUIREMENTS } from "@grokbox/runtime-kernel/host-health";
import { HostVerifier, type StaticJob } from "../src/internal/ops/host-health/verifier.port.ts";
import { hostVerifierLayer } from "../src/internal/io/host-verifier/client.node.ts";
/** Shared test harness, not a production alternate verifier. Always executes
 * the exact binary in the supplied installed artifact directory. */
export async function qualifyVerifierArtifacts(directory:string,artifacts:StaticJob["artifacts"]){
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory}));
 try{return await runtime.runPromise(Effect.gen(function*(){const verifier=yield* HostVerifier;return yield* verifier.analyze({jobId:"qualification",attemptId:crypto.randomUUID(),artifacts,
  checks:HOST_CHECK_REQUIREMENTS.map(({id,revision})=>({id,revision}))});}));}finally{await runtime.dispose();}
}
