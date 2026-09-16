import assert from "node:assert/strict";
import { createStreamingPromptSession, MANAGED_TOOL_POLICY, type SessionTerminal } from "../../src/internal/host/session.ts";
import { buildHostEnvelope } from "../../src/internal/host/context-codec.ts";
const envelope=buildHostEnvelope([{role:"user",content:"synthetic"}],[{name:"lookup",inputSchema:{type:"object"}}]);
const raw=JSON.stringify({q:"x".repeat(30000)});const terminals:SessionTerminal[]=[];
let calls=0;
const session=createStreamingPromptSession({modelId:"test",vision:false,parallel:MANAGED_TOOL_POLICY,onTerminal:t=>terminals.push(t),produce:async function*(){
 calls++;yield {type:"tool-call-streaming-start",toolCallId:"call",toolName:"lookup"};
 for(const argsTextDelta of raw){yield {type:"text-delta",textDelta:"t"};yield {type:"tool-call-delta",toolCallId:"call",toolName:"lookup",argsTextDelta};}
 yield {type:"tool-call",toolCallId:"call",toolName:"lookup",args:JSON.parse(raw)};
 yield {type:"finish",reason:"stop",usage:{promptTokens:3,completionTokens:2,totalTokens:5}};
}});
const handle=session.stream({envelope}),response=await handle.response;assert.equal(response.finishReason,"tool-calls");
for(let reader=0;reader<2;reader++){let text="",args="",count=0;for await(const p of handle.fullStream){if(p.type==="text-delta")text+=p.textDelta;if(p.type==="tool-call-delta")args+=p.argsTextDelta;if(p.type==="tool-call")count++;}assert.equal(text,"t".repeat(raw.length));assert.equal(args,raw);assert.equal(count,1);}
const counts=terminals[0]!.diagnostic!.stream!.counts;
assert.ok(counts.hostEvents!>60000);assert.ok(counts.replayRecords!<40);assert.ok(counts.heldToolRecords!<20);assert.equal(calls,1);
console.log(JSON.stringify({runtime:process.version,events:counts.hostEvents,replayRecords:counts.replayRecords,heldToolRecords:counts.heldToolRecords,semanticOutputBytes:counts.semanticOutputBytes,readers:2,providerAttempts:calls,networkCalls:0}));
