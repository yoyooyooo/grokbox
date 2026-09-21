import { expect, test } from "bun:test";
import { Clock, Effect, Layer, Stream } from "effect";
import { AdmissionAuthority, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer, createCountedSeams } from "@grokbox/runtime-kernel/testing";
import { inferenceMemoryLayer, runStep } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { contextSnapshotBody, streamFailureDiagnostic, projectStreamDiagnostic, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { modeldFailureOutcome } from "../src/internal/modeld/step-outcome.ts";
import { projectModeldStepOutcome } from "../src/internal/io/modeld-outcome.node.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";
import { mapTerminalReject } from "../src/internal/host/failure-catalog.ts";
import { VisibleStreamError } from "../src/internal/host/session.ts";

for(const boundary of ["tool_start","tool_complete","backend_finish"] as const) test(`authority revalidation at ${boundary} preserves the actual boundary with one backend attempt`,async()=>{
 const model="openai/synthetic",agent="a",host="h";
 const models=parseModelsFile({version:3,models:{[model]:{provider:"openai",model:"synthetic",endpoint:"https://offline.invalid/v1",apiKeyRef:"env:KEY",contextWindowTokens:200000,capabilities:{tools:true}}},assignments:{main:null,agents:{[agent]:{modelId:model}}}});
 const selection=captureManagedSelection(models,agent);if(selection.kind!=="managed")throw Error("fixture");
 const body=contextSnapshotBody({version:1,profileId:"p",abiIdentity:"abi",systemMessages:[],messages:[{role:"user",content:"synthetic"}],tools:[{name:"lookup",inputSchema:{type:"object"}}],options:{}});
 const request={hostEpoch:{compile:host,source:"s",profile:"p",hostIdentity:"i",bridgeDigest:"b",wireVersion:"v4"},serviceEpoch:{incarnationId:"epoch"},agentId:agent,turnId:"turn",stepId:"step",selection:{agentId:agent,modelId:model,selectionRevision:selection.selectionRevision},snapshot:{...body,snapshotDigest:computeSnapshotDigest(body)}};
 const counts=createCountedSeams();let refused=false;
 const events:InferenceEvent[]=[{type:"text_delta",text:"progress"},{type:"tool_start",toolCallId:"call",toolName:"lookup"},{type:"tool_delta",toolCallId:"call",toolName:"lookup",argsTextDelta:'{"q":"x"}'},{type:"tool_complete",toolCallId:"call",toolName:"lookup",args:{q:"x"}},{type:"backend_finish",finishReason:"stop",usage:{promptTokens:1,completionTokens:1}}];
 const base=fakeModelBackendLayer(events,counts);
 const wrapped=Layer.effect(ModelBackend,Effect.map(ModelBackend,backend=>({...backend,infer:(...args:Parameters<typeof backend.infer>)=>Stream.tap(backend.infer(...args),e=>Effect.sync(()=>{if(e.type===boundary)refused=true;}))})).pipe(Effect.provide(base)));
 const authority=Layer.succeed(AdmissionAuthority,{current:()=>Effect.map(Clock.currentTimeMillis,observedAtMs=>refused?{admitted:false,reason:"ownership_read_unavailable"}:{admitted:true,ownership:{scopeId:"a".repeat(64),serverId:"server",observedAtMs}})});
 const layer=fakeConfigurationReadLayer({models:()=>models}).pipe(Layer.merge(fakeBackendAuthLayer("synthetic",counts)),Layer.merge(wrapped),Layer.merge(authority),Layer.merge(inferenceMemoryLayer({serviceEpoch:"epoch"})));
 const seen:InferenceEvent[]=[];
 const result=await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const admitted=yield* runStep(request);if(!("stream"in admitted))throw Error("fixture duplicate");return yield* Effect.result(Stream.runForEach(admitted.stream,e=>Effect.sync(()=>{seen.push(e); })));}).pipe(Effect.provide(layer))));
 expect(result._tag).toBe("Failure");if(result._tag!=="Failure")throw Error("fixture");expect(counts.network).toBe(1);
 expect(seen.some(e=>e.type===boundary)).toBe(false);
 const failure=result.failure;expect(streamFailureDiagnostic(failure)).toMatchObject({rejectSite:"authority_check",authority:{reason:"ownership_read_unavailable",checkpoint:boundary==="backend_finish"?"finish":boundary}});
 const outcome=modeldFailureOutcome(failure,"provider",seen.length);
 expect(outcome).toMatchObject({phase:"authority",failureCode:"not_admitted"});
 const terminal=projectModeldStepOutcome({name:"model_step_terminal",schemaVersion:3,at:new Date().toISOString(),hostGenerationId:host,serviceEpoch:"epoch",agentId:agent,turnId:"turn",stepId:"step",...outcome});
 expect(terminal).toMatchObject({diagnostic:{authority:{checkpoint:boundary==="backend_finish"?"finish":boundary}}});
 const hostRow={name:"host_stream_rejected",agentId:agent,turnId:"turn",stepId:"step",hostGenerationId:host,errorCode:"model_error",stage:"provider"};
 const query=projectSendOutcome({agentId:agent,stepId:"step",entries:[],alerts:[],truncated:false,runtimeEvents:[terminal,hostRow]});
 expect(query.runtimeFailure).toMatchObject({code:"not_admitted",stage:"authority",diagnostic:{authority:{reason:"ownership_read_unavailable"}}});
 expect(mapTerminalReject("not_admitted","provider")).toMatchObject({stage:"authority",reason:"authority-rejected"});
 expect(new VisibleStreamError("provider","not_admitted")).toMatchObject({stage:"authority",code:"not_admitted"});
});

test("authority and exact budget projection never copy provider text, credentials or accessors",()=>{
 let accesses=0;const raw={authority:{reason:"ownership_read_timeout",checkpoint:"tool_complete",durationMs:10000,get evidenceAgeMs(){accesses++;return 1;},credential:"SENTINEL"},budget:{layer:"host",metric:"event_count",limit:4096,measured:4097,raw:"SENTINEL"}};
 const safe=projectStreamDiagnostic(raw);expect(accesses).toBe(0);expect(JSON.stringify(safe)).not.toContain("SENTINEL");expect(safe).toMatchObject({authority:{reason:"ownership_read_timeout"},budget:{measured:4097}});
});
