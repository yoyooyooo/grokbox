import { expect,test } from "bun:test";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect,Fiber,Layer } from "effect";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";

for(const api of ["chat","responses"] as const)test(`real SDK ${api} / Unix / production Host accepts >16000 tiny interleaved events`,async()=>{
 const root=await mkdtemp(join(tmpdir(),"stream-fragment-")),generation=randomUUID(),agentId=randomUUID();
 const model={provider:api==="chat"?"openai-chat":"openai-responses",model:"synthetic",endpoint:"https://offline.invalid/v1",apiKeyRef:"env:TEST_KEY",contextWindowTokens:200000,capabilities:{tools:true}};
 const models=parseModelsFile({version:3,models:{"openai/test":model},assignments:{main:null,agents:{[agentId]:{modelId:"openai/test"}}}});await writeFile(join(root,"models.json"),JSON.stringify(models));
 const raw=JSON.stringify({q:"x".repeat(8000)});let fetches=0;let rows:unknown[]=[];const observations:any[]=[];
 const common={id:"resp_test",model:"synthetic",object:"response",created_at:1};
 const item={type:"function_call",id:"item_tool",call_id:"call_tool",name:"lookup",status:"completed",arguments:raw};
 const chat=(delta:unknown,finish_reason:string|null=null)=>({id:"test",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason}],...(finish_reason?{usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}:{})});
 if(api==="chat"){
  rows.push(chat({tool_calls:[{index:0,id:"call_tool",type:"function",function:{name:"lookup",arguments:""}}]}));
  for(const char of raw)rows.push(chat({content:"t",tool_calls:[{index:0,function:{arguments:char}}]}));rows.push(chat({},"tool_calls"));
 }else{
  rows.push({type:"response.created",response:{...common,status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item:{...item,arguments:"",status:"in_progress"}},{type:"response.output_item.added",output_index:1,item:{type:"message",id:"msg",role:"assistant",content:[]}});
  for(const delta of raw)rows.push({type:"response.output_text.delta",item_id:"msg",output_index:1,content_index:0,delta:"t"},{type:"response.function_call_arguments.delta",item_id:"item_tool",output_index:0,delta});
  rows.push({type:"response.function_call_arguments.done",item_id:"item_tool",output_index:0,arguments:raw},{type:"response.output_item.done",output_index:0,item},{type:"response.completed",response:{...common,status:"completed",output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
 }
 const fetchImpl=Object.assign(async()=>{fetches++;let i=0;const encoder=new TextEncoder();return new Response(new ReadableStream<Uint8Array>({pull(c){if(i<rows.length)c.enqueue(encoder.encode('data: '+JSON.stringify(rows[i++])+'\n\n'));else{if(api==="chat")c.enqueue(encoder.encode('data: [DONE]\n\n'));c.close();}}}),{headers:{"content-type":"text/event-stream"}});},{preconnect:async()=>undefined}) as typeof fetch;
 const auth=createLiveBackendAuth({TEST_KEY:"synthetic-only"});const layer=fakeConfigurationReadLayer({models:()=>models}).pipe(Layer.merge(admitAllAuthorityLayer()),Layer.merge(auth.layer),Layer.merge(dispatchingModelBackendLayer(fetchImpl,auth.unseal)),Layer.merge(inferenceMemoryLayer({serviceEpoch:generation})));
 const server=Effect.runFork(Effect.scoped(serveModeld({path:join(root,"modeld.sock"),generation,observeStep:(_r,o)=>Effect.sync(()=>{observations.push(o);})}).pipe(Effect.andThen(Effect.never),Effect.provide(layer))));
 try{
  const deadline=Date.now()+2000;while(!await probeModeldHealth(root,100)){if(Date.now()>deadline)throw Error("fixture readiness");await new Promise(r=>setTimeout(r,5));}
  const hook=bindHostSessionHook({mode:"route",durableRoot:root,runRoot:root,binding:{generationId:"a".repeat(64),activationId:"op",pid:1,start:1,sourceSha:"b".repeat(64),identitySha:"c".repeat(64)},compile:{profileId:"patch-profile",profileSha256:"e".repeat(64),sourceSha256:"b".repeat(64),transformedSha256:"d".repeat(64)}});
  const session=hook({agentId,sessionOptions:{invocationId:randomUUID()}});if(!isHostPromptSession(session))throw Error("fixture managed hook");
  const handle=session.getExecutor([{role:"system",content:"synthetic-root"},{role:"user",content:"synthetic"}]).stream({},randomUUID(),[{name:"lookup",inputSchema:{type:"object"}}]);
  // Intentionally consume only after completion: this exercises bounded late-reader storage.
  const response=await handle.response;const parts:any[]=[];for await(const p of handle.fullStream)parts.push(p);
  expect(response.finishReason).toBe("tool-calls");expect(fetches).toBe(1);
  expect(parts.filter(p=>p.type==="text-delta").map(p=>p.textDelta).join("")).toBe("t".repeat(raw.length));
  expect(parts.filter(p=>p.type==="tool-call-delta").map(p=>p.argsTextDelta).join("")).toBe(raw);
  expect(parts.filter(p=>p.type==="tool-call")).toMatchObject([{toolCallId:"call_tool",args:{q:"x".repeat(8000)}}]);
  const until=Date.now()+2000;while(!observations.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  expect(observations[0]).toMatchObject({outcome:"ok",backendAttempts:1});expect(observations[0].eventCount).toBeGreaterThan(16000);
 }finally{await Effect.runPromise(Fiber.interrupt(server));await rm(root,{recursive:true,force:true});}
},30000);
