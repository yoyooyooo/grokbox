import { Effect } from "effect";
import { hostHealthView, type HostHealthView } from "@grokbox/client/contract";
import type { HostHealthStatus } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
/** Public read projection only. No filesystem, native call, subprocess, refresh,
 * storage initialization or recovery is performed by this HTTP request. */
export function hostHealthQuery(installationId:string, read:(()=>HostHealthStatus)|undefined, principal:Principal, method:string, url:URL) {
  return Effect.try({try:():HostHealthView=>{
    requireCapability(principal,"system.read");
    if(method!=="GET"||url.search)throw new HttpFailure(400,"invalid_input","Host health is an observation-only endpoint without query parameters.");
    if(!read)throw new HttpFailure(503,"unavailable","The installation health producer is not available.");
    const value={component:"host-integration" as const,...read()};
    if(!hostHealthView(value,installationId))throw new HttpFailure(503,"unavailable","The health observation failed its public contract.");
    return value;
  },catch:error=>error});
}
