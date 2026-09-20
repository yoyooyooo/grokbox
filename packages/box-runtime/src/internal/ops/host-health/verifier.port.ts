import { Context, Effect } from "effect";
import type { StaticAnalysis } from "@grokbox/runtime-kernel/host-health";
export type StaticJob = {jobId:string;attemptId:string;artifacts:{role:"source"|"candidate"|"companion";bytes:Uint8Array}[];checks:{id:string;revision:number}[]};
export class HostVerifier extends Context.Service<HostVerifier, {
  identity:()=>Effect.Effect<{buildId:string;schemaDigest:string},Error>;
  analyze:(job:StaticJob)=>Effect.Effect<StaticAnalysis,Error>;
}>()("grokbox/HostVerifier") {}
