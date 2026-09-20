import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient } from "../src/client.ts";
import { hostHealthView } from "../src/host-health-contract.ts";
import { HOST_CHECK_REQUIREMENTS, hostHealthConditions, hostHealthSummary, projectHostHealth, type HostHealthEvidence } from "@grokbox/runtime-kernel/host-health";
const installation="11111111-1111-4111-8111-111111111111";
const evidence=():HostHealthEvidence=>({name:"host_patch_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:installation,contractRevision:"host-health-v2",sourceInstanceId:"a".repeat(64),sourceSequence:0,
 sourceState:"stable",sourceSet:"b".repeat(64),sourceSha:"c".repeat(64),workerSha:"d".repeat(64),profileDigest:"e".repeat(64),candidateSha:"f".repeat(64),checkerBuildId:"1".repeat(64),companionQualification:"not-required",
 applicability:"exact",analysis:"passed",requiredChecks:HOST_CHECK_REQUIREMENTS.map(c=>c.id),failedChecks:[],unsupportedChecks:[],uncoveredSlices:["create-session"],loaded:"not-observed",attachment:"not-observed",exercised:"not-exercised",notificationCoverage:"local-only",detectorCode:null,qualified:false});
const view=()=>({component:"host-integration",owner:"management-server",state:"running",reason:"observed",observedAtMs:Date.now(),lastAttemptAtMs:Date.now(),assessment:"degraded",latest:evidence(),intake:"committed",runtime:null,witness:null,runtimeIntake:"not-observed",watch:"active",analyses:1,qualified:false,executionAuthority:false});
test("scoped static passes never certify loaded identity, exercised behavior or independent delivery",()=>{const v=evidence();expect(projectHostHealth(v)).not.toBeNull();expect(hostHealthSummary(v)).toBe("degraded");expect(hostHealthView(view(),installation)).toBe(true);});
test("historical static receipts retain their obligation set without certifying the added lifetime requirement",()=>{
 const old={...evidence(),contractRevision:"host-health-v1" as const,requiredChecks:HOST_CHECK_REQUIREMENTS.filter(c=>c.id!=="context.lease-finally").map(c=>c.id)};
 expect(projectHostHealth(old)).toEqual(old);expect(hostHealthSummary(old)).toBe("unknown");
 expect(projectHostHealth({...old,contractRevision:"host-health-v2"})).toBeNull();
 let reads=0;Object.defineProperty(old,"contractRevision",{enumerable:true,get(){reads++;return "host-health-v1";}});
 expect(projectHostHealth(old)).toBeNull();expect(reads).toBe(0);
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
