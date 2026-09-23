/** Pure health semantics, independent of wire, parser, filesystem and execution authority. */
export * from "./host-compilation.ts";
export * from "./host-witness.ts";
export * from "./host-source-evolution.ts";
import { projectHostSourceEvolution, type HostSourceEvolution } from "./host-source-evolution.ts";
export const HOST_HEALTH_CONTRACT = "host-health-v2";
export const HOST_CHECK_REQUIREMENTS = [
  { id:"session.main-binding", revision:2, slices:["agent-id"], scope:"main-options-binding" },
  { id:"retry.turn-guard", revision:2, slices:["managed-turn-retry-gate"], scope:"turn-entry-managed-refusal" },
  { id:"context.checkpoint-await", revision:2, slices:["compact-register"], scope:"checkpoint-callback-settlement" },
  { id:"context.lease-finally", revision:1, slices:["compact-register"], scope:"sync-resource-scope-and-preflight-order" },
] as const;
export type StaticCheck = { id:string; revision:number; state:"passed"|"violated"|"unsupported"; code:string; start:number; end:number };
export type StaticAnalysis = { jobId:string; attemptId:string; buildId:string; schemaDigest:string; parser:string;
  artifacts:{role:"source"|"candidate"|"companion";sha256:string;bytes:number;valid:boolean;diagnostics:number;nodes:number}[];
  checks:StaticCheck[]; elapsedMs:number };
export type HostHealthEvidence = {
  name:"host_patch_health"; schemaVersion:1; eventId:string; at:string; installationId:string; contractRevision:typeof HOST_HEALTH_CONTRACT;
  sourceInstanceId:string; sourceSequence:number; sourceState:"stable"|"snapshot"|"unavailable"|"changed"; sourceSet:string|null; sourceSha:string|null; workerSha:string|null; profileDigest:string|null; candidateSha:string|null; checkerBuildId:string|null;
  companionQualification:"not-required"|"matched"|"unreviewed";
  applicability:"exact"|"mismatch"|"profile-unavailable"; analysis:"pending"|"passed"|"violated"|"unsupported"|"unavailable";
  requiredChecks:string[]; failedChecks:string[]; unsupportedChecks:string[]; uncoveredSlices:string[];
  loaded:"not-observed"; attachment:"not-observed"; exercised:"not-exercised"; notificationCoverage:"local-only";
  detectorCode:string|null; qualified:false;
  /** Additive source-window evidence. Historical v2 receipts remain scoped to
   * their original fields; absence cannot be promoted to new regression proof. */
  recipeSha?:string; sourceEvolution?:HostSourceEvolution;
};
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const tokens=(v:unknown,max:number):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==="string"&&/^[a-z][a-z0-9.-]{0,79}$/.test(s))&&new Set(v).size===v.length;
/** Reproject, never accept private additions, paths, AST or inferred load proof. */
export function projectHostHealth(value:unknown):HostHealthEvidence|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as HostHealthEvidence;
  const keys=["name","schemaVersion","eventId","at","installationId","contractRevision","sourceInstanceId","sourceSequence","sourceState","sourceSet","sourceSha","workerSha","profileDigest","candidateSha","checkerBuildId","companionQualification","applicability","analysis","requiredChecks","failedChecks","unsupportedChecks","uncoveredSlices","loaded","attachment","exercised","notificationCoverage","detectorCode","qualified"];
  const enriched = Object.hasOwn(v,"recipeSha") || Object.hasOwn(v,"sourceEvolution");
  if(enriched)keys.push("recipeSha","sourceEvolution");
  if(Reflect.ownKeys(v).length!==keys.length||Reflect.ownKeys(v).some(k=>typeof k!=="string"||!keys.includes(k)||!("value" in Object.getOwnPropertyDescriptor(v,k)!)))return null;
  // One current contract. Old files remain untouched, but cannot enter the
  // live evidence pipeline by reducing its required proof obligations.
  const required = HOST_CHECK_REQUIREMENTS;
  if(v.name!=="host_patch_health"||v.schemaVersion!==1||!uuid(v.eventId)||!uuid(v.installationId)||v.contractRevision!==HOST_HEALTH_CONTRACT||!hash(v.sourceInstanceId)||!["stable","snapshot","unavailable","changed"].includes(v.sourceState)
    ||(["stable","snapshot"].includes(v.sourceState)? !hash(v.sourceSet)||!hash(v.sourceSha)||!hash(v.workerSha) : v.sourceSet!==null||v.sourceSha!==null||v.workerSha!==null||v.profileDigest!==null||v.candidateSha!==null)
    ||v.workerSha!==null&&!hash(v.workerSha)||v.profileDigest!==null&&!hash(v.profileDigest)||v.candidateSha!==null&&!hash(v.candidateSha)||v.checkerBuildId!==null&&!hash(v.checkerBuildId)||!Number.isSafeInteger(v.sourceSequence)||v.sourceSequence<0
    ||typeof v.at!=="string"||!Number.isFinite(Date.parse(v.at))||new Date(v.at).toISOString()!==v.at
    ||!["not-required","matched","unreviewed"].includes(v.companionQualification)||!["exact","mismatch","profile-unavailable"].includes(v.applicability)||!["pending","passed","violated","unsupported","unavailable"].includes(v.analysis)
    ||!tokens(v.requiredChecks,32)||!tokens(v.failedChecks,32)||!tokens(v.unsupportedChecks,32)||!tokens(v.uncoveredSlices,128)
    ||v.requiredChecks.length!==required.length||required.some(c=>!v.requiredChecks.includes(c.id))
    ||v.failedChecks.some(id=>!v.requiredChecks.includes(id))||v.unsupportedChecks.some(id=>!v.requiredChecks.includes(id))
    ||v.loaded!=="not-observed"||v.attachment!=="not-observed"||v.exercised!=="not-exercised"||v.notificationCoverage!=="local-only"||v.qualified!==false
    ||v.detectorCode!==null&&(typeof v.detectorCode!=="string"||!/^[a-z][a-z0-9-]{0,79}$/.test(v.detectorCode)))return null;
  if (v.analysis==="passed" && (v.applicability!=="exact"||!hash(v.checkerBuildId)||!hash(v.candidateSha)||v.failedChecks.length||v.unsupportedChecks.length)) return null;
  if (!["stable","snapshot"].includes(v.sourceState) && (v.analysis!=="unavailable"||v.applicability!=="profile-unavailable")) return null;
  if (v.sourceState==="snapshot" && (!enriched || ["pending","unavailable"].includes(v.analysis))) return null;
  if (enriched && (!hash(v.recipeSha) || !projectHostSourceEvolution(v.sourceEvolution)
    || !["stable","snapshot"].includes(v.sourceState) || v.sourceEvolution!.observed.host!==v.sourceSha || v.sourceEvolution!.observed.worker!==v.workerSha)) return null;
  if (v.failedChecks.some(id=>v.unsupportedChecks.includes(id))) return null;
  if (enriched) {
    const evolution=v.sourceEvolution!;
    // This event is produced by the read-only static owner. Native ABI proof
    // stays in explicit qualification receipts, not a forged static addition.
    if(evolution.nativeAbi.state!=="not-run")return null;
    const expected=v.analysis==="pending"||v.analysis==="unavailable"?"not-run":v.failedChecks.length?"failed":v.unsupportedChecks.length?"incomplete":"passed";
    if(evolution.semantics.state!==expected||JSON.stringify(evolution.semantics.failed.map(c=>c.id))!==JSON.stringify(v.failedChecks)
      ||JSON.stringify(evolution.semantics.unsupported.map(c=>c.id))!==JSON.stringify(v.unsupportedChecks)
      ||[...evolution.semantics.failed,...evolution.semantics.unsupported].some(check=>!HOST_CHECK_REQUIREMENTS.some(c=>c.id===check.id&&c.revision===check.revision)))return null;
  }
  return {...v,...(enriched?{sourceEvolution:projectHostSourceEvolution(v.sourceEvolution)!}:{}),requiredChecks:[...v.requiredChecks],failedChecks:[...v.failedChecks],unsupportedChecks:[...v.unsupportedChecks],uncoveredSlices:[...v.uncoveredSlices]};
}
/** Persisted analysis is revalidated as a domain record, not trusted because a
 * prior process accepted a protocol report. No source snippets or AST survive. */
export function validStaticAnalysis(raw:unknown):raw is StaticAnalysis {
  const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Reflect.ownKeys(v).length===keys.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.includes(k)&&'value' in Object.getOwnPropertyDescriptor(v,k)!);
  const integer=(v:unknown,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
  const v=raw as StaticAnalysis;
  if(!exact(v,['jobId','attemptId','buildId','schemaDigest','parser','artifacts','checks','elapsedMs'])||![v.jobId,v.attemptId].every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id))||!hash(v.buildId)||!hash(v.schemaDigest)||v.parser!=='oxc-0.75.0'||!integer(v.elapsedMs,180000))return false;
  if(!Array.isArray(v.artifacts)||v.artifacts.length<1||v.artifacts.length>3||v.artifacts.some(a=>!exact(a,['role','sha256','bytes','valid','diagnostics','nodes'])||!['source','candidate','companion'].includes(a.role)||!hash(a.sha256)||!integer(a.bytes,67108864)||a.bytes<1||typeof a.valid!=='boolean'||!integer(a.diagnostics,1000000)||!integer(a.nodes,10000000)||a.valid&&a.diagnostics!==0)||new Set(v.artifacts.map(a=>a.role)).size!==v.artifacts.length||!v.artifacts.some(a=>a.role==='source'))return false;
  const candidate=v.artifacts.find(a=>a.role==='candidate');
  return Array.isArray(v.checks)&&v.checks.length===HOST_CHECK_REQUIREMENTS.length&&new Set(v.checks.map(c=>c.id)).size===v.checks.length&&v.checks.every(c=>exact(c,['id','revision','state','code','start','end'])&&HOST_CHECK_REQUIREMENTS.some(required=>required.id===c.id&&required.revision===c.revision)&&['passed','violated','unsupported'].includes(c.state)&&typeof c.code==='string'&&/^[a-z][a-z0-9-]{0,79}$/.test(c.code)&&integer(c.start,candidate?.bytes??0)&&integer(c.end,candidate?.bytes??0)&&c.start<=c.end&&(c.state!=='passed'||candidate?.valid===true));
}
export function hostHealthSummary(v:HostHealthEvidence):"blocked"|"unknown"|"degraded" {
  if(v.sourceState!=="stable")return "unknown";
  if(v.applicability==="mismatch"||v.analysis==="violated")return "blocked";
  if(v.applicability!=="exact"||v.analysis!=="passed")return "unknown";
  // These scoped static proofs never assert full capability/load/use qualification.
  return "degraded";
}
export function hostHealthConditions(v:HostHealthEvidence):{cause:"applicability"|"semantics"|"sensing"|"companion";result:"failed"|"passed"|"unknown"}[]{
  // A completed superseded window is traceable evidence, not a new current
  // failure/recovery opportunity. It may not resolve or reopen live conditions.
  if(v.sourceState==="snapshot")return [];
  return [{cause:"applicability",result:v.sourceState!=="stable"?"unknown":v.applicability==="exact"?"passed":"failed"},
    {cause:"semantics",result:v.analysis==="violated"?"failed":v.analysis==="passed"?"passed":"unknown"},
    {cause:"sensing",result:v.analysis==="unavailable"||v.analysis==="unsupported"&&v.applicability==="exact"?"failed":["passed","violated","unsupported"].includes(v.analysis)?"passed":"unknown"},
    {cause:"companion",result:v.companionQualification==="unreviewed"?"failed":v.companionQualification==="matched"?"passed":"unknown"}];
}
