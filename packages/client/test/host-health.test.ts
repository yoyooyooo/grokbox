import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient } from "../src/client.ts";
import { hostHealthView } from "../src/host-health-contract.ts";
import { describeHostSourceEvolution, HOST_CHECK_REQUIREMENTS, hostHealthConditions, hostHealthSummary, projectHostHealth, validStaticAnalysis, type HostHealthEvidence } from "@grokbox/runtime-kernel/host-health";
const installation="11111111-1111-4111-8111-111111111111";
const evidence=():HostHealthEvidence=>({name:"host_patch_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:installation,contractRevision:"host-health-v2",sourceInstanceId:"a".repeat(64),sourceSequence:0,
 sourceState:"stable",sourceSet:"b".repeat(64),sourceSha:"c".repeat(64),workerSha:"d".repeat(64),profileDigest:"e".repeat(64),candidateSha:"f".repeat(64),checkerBuildId:"1".repeat(64),companionQualification:"not-required",
 applicability:"exact",analysis:"passed",requiredChecks:HOST_CHECK_REQUIREMENTS.map(c=>c.id),failedChecks:[],unsupportedChecks:[],uncoveredSlices:["create-session"],loaded:"not-observed",attachment:"not-observed",exercised:"not-exercised",notificationCoverage:"local-only",detectorCode:null,qualified:false});
test("late immutable snapshot remains valid evidence but cannot be live health or alter conditions",()=>{
 const v=evidence();v.sourceState="snapshot";v.recipeSha="a".repeat(64);
 v.sourceEvolution=describeHostSourceEvolution({host:v.sourceSha!,worker:v.workerSha!},{host:v.sourceSha!,worker:v.workerSha!},"applicable-not-reviewed",{
   semantics:{state:"passed",failed:[],unsupported:[]},uncoveredSlices:["create-session"]});
 expect(projectHostHealth(v)).not.toBeNull();expect(hostHealthConditions(v)).toEqual([]);expect(hostHealthSummary(v)).toBe("unknown");
 expect(hostHealthView({...view(),latest:v},installation)).toBe(false);
 expect(projectHostHealth({...v,recipeSha:undefined})).toBeNull();
 expect(projectHostHealth({...v,sourceEvolution:{...v.sourceEvolution,observed:{...v.sourceEvolution.observed,host:"0".repeat(64)}}})).toBeNull();
 expect(projectHostHealth({...v,sourceEvolution:{...v.sourceEvolution,privateSource:"no"}})).toBeNull();
});
const view=()=>({component:"host-integration",owner:"management-server",state:"running",reason:"observed",observedAtMs:Date.now(),lastAttemptAtMs:Date.now(),assessment:"degraded",latest:evidence(),intake:"committed",runtime:null,witness:null,runtimeIntake:"not-observed",watch:"active",analyses:1,qualified:false,executionAuthority:false});
test("scoped static passes never certify loaded identity, exercised behavior or independent delivery",()=>{const v=evidence();expect(projectHostHealth(v)).not.toBeNull();expect(hostHealthSummary(v)).toBe("degraded");expect(hostHealthView(view(),installation)).toBe(true);});
test("retired static contracts cannot reduce current proof obligations or enter the live client",()=>{
 const old={...evidence(),contractRevision:"host-health-v1" as const,requiredChecks:HOST_CHECK_REQUIREMENTS.filter(c=>c.id!=="context.lease-finally").map(c=>c.id)};
 expect(projectHostHealth(old)).toBeNull();expect(hostHealthView({...view(),latest:old},installation)).toBe(false);
 expect(projectHostHealth({...old,contractRevision:"host-health-v2"})).toBeNull();
 expect(projectHostHealth({...old,requiredChecks:evidence().requiredChecks})).toBeNull();
 let reads=0;Object.defineProperty(old,"contractRevision",{enumerable:true,get(){reads++;return "host-health-v1";}});
 expect(projectHostHealth(old)).toBeNull();expect(reads).toBe(0);
});

test("persisted static reports cannot replace current semantic rules with older revisions",()=>{
 const report={jobId:randomUUID(),attemptId:randomUUID(),buildId:"a".repeat(64),schemaDigest:"b".repeat(64),parser:"oxc-0.75.0",elapsedMs:1,
   artifacts:["source","candidate","companion"].map(role=>({role,sha256:"c".repeat(64),bytes:16,valid:true,diagnostics:0,nodes:8})),
   checks:HOST_CHECK_REQUIREMENTS.map(c=>({id:c.id,revision:c.revision,state:"passed",code:"scoped-test",start:0,end:1}))};
 expect(validStaticAnalysis(report)).toBe(true);
 expect(validStaticAnalysis({...report,checks:report.checks.map(c=>c.id==="session.main-binding"?{...c,revision:1}:c)})).toBe(false);
 expect(validStaticAnalysis({...report,checks:report.checks.slice(1)})).toBe(false);
 expect(validStaticAnalysis({...report,checks:report.checks.map(c=>c.id==="context.lease-finally"?{...c,id:"future.unreviewed"}:c)})).toBe(false);
});

test("missing requirements, private source fields, fabricated loaded proof and contradictory passes are rejected",()=>{
 for(const v of [{...evidence(),requiredChecks:[]},{...evidence(),sourceText:"private"},{...evidence(),loaded:"matching"},{...evidence(),qualified:true},{...evidence(),analysis:"passed",failedChecks:["retry.turn-guard"]},{...evidence(),notificationCoverage:"delivered"}])expect(projectHostHealth(v)).toBeNull();
});
test("health projection does not execute a property getter",()=>{let accesses=0;const v=evidence();Object.defineProperty(v,"analysis",{enumerable:true,get:()=>{accesses++;return "passed";}});expect(projectHostHealth(v)).toBeNull();expect(accesses).toBe(0);});
test("whole health transport rejects top-level getters without evaluating them",()=>{
 const v=view();let accesses=0;Object.defineProperty(v,"runtime",{enumerable:true,get(){accesses++;return null;}});
 expect(hostHealthView(v,installation)).toBe(false);expect(accesses).toBe(0);
});
test("known mismatch survives analyzer failure and missing sources cannot supply a repair",()=>{
 const mismatch={...evidence(),applicability:"mismatch" as const,analysis:"unavailable" as const,candidateSha:null};expect(hostHealthSummary(mismatch)).toBe("blocked");
 expect(hostHealthConditions(mismatch).find(c=>c.cause==="applicability")?.result).toBe("failed");
 const gap={...evidence(),sourceState:"unavailable" as const,sourceSet:null,sourceSha:null,workerSha:null,profileDigest:null,candidateSha:null,analysis:"unavailable" as const,applicability:"profile-unavailable" as const};
 expect(projectHostHealth(gap)).not.toBeNull();expect(hostHealthConditions(gap).filter(c=>["applicability","semantics"].includes(c.cause)).every(c=>c.result==="unknown")).toBe(true);
});
test("shared client binds the public health view to the installation and rejects leaked implementation fields",async()=>{
 for(const data of [{...view(),rawAst:{}},{...view(),latest:{...evidence(),installationId:randomUUID()}},{...view(),executionAuthority:true}]){
 const client=new ManagementClient({baseUrl:"http://127.0.0.1",installationId:installation,fetch:(async(_input:Parameters<typeof fetch>[0],_init?:Parameters<typeof fetch>[1])=>Response.json({schemaVersion:1,installationId:installation,invocationId:randomUUID(),ok:true,data})) as typeof fetch});
 await expect(client.hostHealth()).rejects.toMatchObject({code:"protocol_error"});}
});
