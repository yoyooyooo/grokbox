import {projectHostHealth,projectHostRuntimeObservation,projectHostWitnessObservation,type HostWitnessObservation,type HostRuntimeObservation,type HostHealthEvidence} from "@grokbox/runtime-kernel/host-health";
export type HostHealthView={component:"host-integration";owner:"management-server";state:"starting"|"disabled"|"running"|"blocked"|"stopped";
  reason:string;observedAtMs:number|null;lastAttemptAtMs:number|null;assessment:"blocked"|"unknown"|"degraded";latest:HostHealthEvidence|null;
  intake:"not-observed"|"committed"|"unavailable"|"gap";runtime:HostRuntimeObservation|null;witness:HostWitnessObservation|null;runtimeIntake:"not-observed"|"committed"|"unavailable"|"gap";watch:"active"|"backstop-only";analyses:number;qualified:false;executionAuthority:false};
export function hostHealthView(value:unknown,installationId:string):value is HostHealthView{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const keys=["component","owner","state","reason","observedAtMs","lastAttemptAtMs","assessment","latest","intake","runtime","witness","runtimeIntake","watch","analyses","qualified","executionAuthority"];
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(k=>!descriptors[k]||!("value" in descriptors[k]!)))return false;
  const v=Object.fromEntries(keys.map(k=>[k,descriptors[k]!.value])) as HostHealthView;
  const at=(n:unknown)=>n===null||typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
  return Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k))&&v.component==="host-integration"&&v.owner==="management-server"
    &&["starting","disabled","running","blocked","stopped"].includes(v.state)&&typeof v.reason==="string"&&/^[a-z][a-z0-9-]{0,79}$/.test(v.reason)
    &&at(v.observedAtMs)&&at(v.lastAttemptAtMs)&&["blocked","unknown","degraded"].includes(v.assessment)
    &&(v.latest===null||projectHostHealth(v.latest)!==null&&v.latest.installationId===installationId)
    &&(v.runtime===null||projectHostRuntimeObservation(v.runtime)!==null)
    &&(v.witness===null||projectHostWitnessObservation(v.witness)!==null)
    &&(!v.witness?.snapshot||v.runtime?.state==="current"&&v.witness.snapshot.compilation.observationId===v.runtime.receipt?.observationId)
    &&["not-observed","committed","unavailable","gap"].includes(v.runtimeIntake)
    &&["not-observed","committed","unavailable","gap"].includes(v.intake)&&["active","backstop-only"].includes(v.watch)
    &&Number.isSafeInteger(v.analyses)&&v.analyses>=0&&v.qualified===false&&v.executionAuthority===false;
}
