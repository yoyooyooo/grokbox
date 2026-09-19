import {expect,test} from "bun:test";
import { botWorkflowRequest,botWorkflowDigest,botProfile,botSupplement,materialFromBotSupplement,readBotSupplement,
  replaceSupplementInstructions,currentContextSeed,summaryFromSupplement,continuityProtection,botProtection,protectionRevision,
  replacementBudget,recordInbound,assessRetirement,handoverPolicy,discoverPeers,importedHistory } from "../src/continuity.ts";
import {sha256Text} from "../src/hash.ts";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",op="cccccccc-cccc-4ccc-8ccc-cccccccccccc",scope="d".repeat(64);
const request=()=>({version:1,operationId:op,scopeId:scope,kind:"spawn",sourceId:null,profile:{name:"worker"},modelRef:null,instructions:"Role instruction",snapshotId:null,activate:true,start:true,maxRunMs:1000,policyRevision:"e".repeat(64)});
const supplement=()=>botSupplement({version:1,sourceId:id,memory:[{content:"Known fact",kind:"profile",createdAt:1}],history:[{kind:"message",id:"past-1",role:"user",content:"Past task",timestampMs:2}],memoryComplete:true,historyComplete:false});

test("one identity initialization request binds profile, model, instructions and policy without session products",()=>{
 const first=botWorkflowRequest(request());expect(first.kind).toBe("spawn");expect(botWorkflowDigest(first)).not.toBe(botWorkflowDigest({...first,instructions:"changed"}));
 expect(()=>botWorkflowRequest({...request(),sourceId:id})).toThrow();expect(()=>botWorkflowRequest({...request(),start:true,activate:false})).toThrow();
 expect(()=>botWorkflowRequest({...request(),sessions:[]})).toThrow();expect(()=>botWorkflowRequest({...request(),kind:"clone"})).toThrow();
});
test("material keeps history attribution and cannot elevate transcripts into managed instructions",()=>{
 const s=supplement();const material=materialFromBotSupplement(s,{agentId:id,scopeId:scope,contextRevision:"source",nativeSchema:"test",capturedAtMs:3,transcriptThrough:null});
 expect(material.manifest.quality).toBe("memory_only");expect(material.manifest.root).toBeNull();expect(material.manifest.gaps).toContain("missing_native_root");
 const changed=replaceSupplementInstructions(material,"explicit instructions");expect(readBotSupplement(changed)?.instructions).toBe("explicit instructions");expect(readBotSupplement(material)?.instructions).toBeUndefined();
 const imported=importedHistory(s,target);expect(imported[0]?.id).not.toBe("past-1");expect(imported[0]?.continuitySource).toEqual({agentId:id,entryId:"past-1",historical:true});
 const summary=summaryFromSupplement(s);expect(summary).toContain("Past task");expect(summary).toContain(id);
 expect(()=>currentContextSeed({version:1,purpose:"reset",sourceId:id,sourceRevision:sha256Text("a"),instructions:"",summary:"old task"})).toThrow();
});
test("policies default off globally and pause routines when a Bot is explicitly protected",()=>{
 expect(continuityProtection()).toEqual({enabled:false,intervalMs:30000,bots:{}});
 const p=botProtection();expect(p).toMatchObject({mode:"alert",tier:"resume",pauseOnOwnershipLoss:true});expect(p.handover.automaticDelete).toBe(false);
 expect(botProtection({pauseOnOwnershipLoss:false}).pauseOnOwnershipLoss).toBe(false);
 expect(protectionRevision(id,p)).not.toBe(protectionRevision(id,{...p,pauseOnOwnershipLoss:false}));
 expect(()=>continuityProtection({enabled:true,bots:{not_an_id:{}}})).toThrow();
 expect(replacementBudget(p,[100000],100001)).toMatchObject({allowed:false,reason:"cooldown"});
 expect(replacementBudget(p,[200000],100001)).toMatchObject({allowed:false,reason:"clock_invalid"});
});
test("quiet time excludes monitoring gaps and fresh inbound resets eligibility",()=>{
 const policy=handoverPolicy({automaticDelete:true,minGraceMs:60000,quietMs:60000});
 let w=recordInbound(null,{cursor:sha256Text("1"),observedAtMs:100000,newMessages:0,contiguous:true});
 w=recordInbound(w,{cursor:sha256Text("1"),observedAtMs:170000,newMessages:0,contiguous:true});
 const input={policy,nowMs:170000,createdAtMs:1,inbound:w,remaining:0,unknown:0,targetUsable:true,dependenciesVerified:true,resourcesIndependent:true,deletionFenceAvailable:true};
 expect(assessRetirement(input).automaticDeleteAuthorized).toBe(true);
 const newInput=recordInbound(w,{cursor:sha256Text("2"),observedAtMs:170000,newMessages:1,contiguous:true});expect(assessRetirement({...input,inbound:newInput}).blockers).toContain("quiet_period");
 const gap=recordInbound(w,{cursor:null,observedAtMs:170000,newMessages:0,contiguous:false});expect(assessRetirement({...input,inbound:gap}).blockers).toContain("inbound_coverage_gap");
 expect(assessRetirement({...input,deletionFenceAvailable:false}).eligible).toBe(false);
 expect(assessRetirement({...input,unknown:1}).blockers).toContain("unknown_effects");
});
test("peer discovery uses actual structured peers, not mentions, and never invokes accessors",()=>{
 let evaluated=0;const nasty={get fromAgent(){evaluated++;return {id:target};}};
 expect(discoverPeers([{content:target},nasty,{fromAgent:{id:target}},{toAgent:{id:target}},{fromAgent:{id}}],id)).toEqual([target]);expect(evaluated).toBe(0);
 let called=0;expect(()=>botProfile({name:"n",get description(){called++;return "x";}})).toThrow();expect(called).toBe(0);
});
