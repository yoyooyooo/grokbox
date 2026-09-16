import { expect, test } from "bun:test";
import { ChunkedText, StreamOutputBudget, CANONICAL_OUTPUT_MAX_BYTES, streamFailureDiagnostic, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { createStreamingPromptSession, MANAGED_TOOL_POLICY, type StreamPart, type SessionTerminal } from "../src/internal/host/session.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { replayStream } from "../src/internal/host/replay-stream.ts";
import { createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";
import { StreamEvidence } from "@grokbox/runtime-kernel/contract";

const usage = { promptTokens: 2, completionTokens: 4, totalTokens: 6 };
const stop: StreamPart = { type: "finish", reason: "stop", usage };
const envelope = buildHostEnvelope([{ role: "user", content: "synthetic" }], [{ name: "lookup", inputSchema: { type: "object" } }]);
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const all:T[]=[]; for await (const part of source) all.push(part); return all; }

for (const fragment of [1, 7, 1024]) test(`production mixed text/tool output is not limited by fragmentation size=${fragment}`, async () => {
  const text = "result ".repeat(4000), raw = JSON.stringify({ q: "x".repeat(28000) });
  const terminals: SessionTerminal[] = [];
  const prompt = createStreamingPromptSession({ modelId: "test", vision: false, parallel: MANAGED_TOOL_POLICY,
    onTerminal: t => terminals.push(t), produce: async function* () {
      yield { type: "tool-call-streaming-start", toolCallId: "call", toolName: "lookup" };
      for(let offset=0;offset<Math.max(text.length,raw.length);offset+=fragment){
        if(offset<text.length)yield { type: "text-delta", textDelta: text.slice(offset,offset+fragment) };
        if(offset<raw.length)yield { type: "tool-call-delta", toolCallId: "call", toolName: "lookup", argsTextDelta: raw.slice(offset,offset+fragment) };
      }
      yield { type: "tool-call", toolCallId: "call", toolName: "lookup", args: JSON.parse(raw) };
      yield stop;
    } });
  const handle = prompt.stream({ envelope }); const response = await handle.response;
  const parts = await collect(handle.fullStream), late = await collect(handle.fullStream);
  expect(parts).toEqual(late);
  expect(parts.filter(p=>p.type==="text-delta").map(p=>(p as {textDelta:string}).textDelta).join("")).toBe(text);
  expect(parts.filter(p=>p.type==="tool-call-delta").map(p=>(p as {argsTextDelta:string}).argsTextDelta).join("")).toBe(raw);
  expect(parts.filter(p=>p.type==="tool-call")).toHaveLength(1);
  expect(response.finishReason).toBe("tool-calls");
  const counts=terminals[0]!.diagnostic!.stream!.counts;
  expect(counts.semanticOutputBytes).toBe(text.length+raw.length+"calllookup".length+64);
  expect(counts.heldToolRecords).toBeLessThan(20);expect(counts.replayRecords).toBeLessThan(40);
  if(fragment===1){ expect(counts.hostEvents).toBeGreaterThan(56000); expect(counts.hostBytes).toBeGreaterThan(1_000_000); }
}, 15_000);

test("semantic budget counts final tool arguments once and split Unicode as concatenated UTF-8",()=>{
  for(const fragments of [["A😀B"],["A","\ud83d","\ude00","B"]]){
    const b=new StreamOutputBudget(6);for(const text of fragments)expect(b.add({type:"text_delta",text})).toBe(true);expect(b.used).toBe(6);
  }
  const b=new StreamOutputBudget(),raw='{"q":"test"}';
  b.add({type:"tool_start",toolCallId:"id",toolName:"lookup"});
  for(const argsTextDelta of raw)b.add({type:"tool_delta",toolCallId:"id",toolName:"lookup",argsTextDelta});
  const before=b.used; b.add({type:"tool_complete",toolCallId:"id",toolName:"lookup",args:JSON.parse(raw)});
  expect(b.used).toBe(before);
});

test("a genuine payload overrun is explicit and releases zero held tools",async()=>{
  const prompt=createStreamingPromptSession({modelId:"test",vision:false,parallel:MANAGED_TOOL_POLICY,maxBytes:100,
    produce:async function*(){yield {type:"tool-call-streaming-start",toolCallId:"id",toolName:"lookup"};yield {type:"tool-call-delta",toolCallId:"id",toolName:"lookup",argsTextDelta:'{"q":"'+"x".repeat(101)};yield stop;} });
  const handle=prompt.stream({envelope}),parts=await collect(handle.fullStream),error=await handle.response.catch(e=>e);
  expect(parts.some(p=>p.type.startsWith("tool-call"))).toBe(false);
  expect(error).toMatchObject({code:"stream_limit",stage:"normalize"});
  expect(streamFailureDiagnostic(error)).toMatchObject({budget:{layer:"host",metric:"output_bytes",limit:100},normalizeCause:"stream_budget"});
});

test("final replay reservation rejects an oversized representation before releasing any tool", async () => {
  const raw = JSON.stringify({ q: "x".repeat(880000) });
  const prompt = createStreamingPromptSession({ modelId: "test", vision: false, parallel: MANAGED_TOOL_POLICY, produce: async function* () {
    yield { type: "tool-call-streaming-start", toolCallId: "id", toolName: "lookup" };
    yield { type: "tool-call-delta", toolCallId: "id", toolName: "lookup", argsTextDelta: raw };
    yield { type: "tool-call", toolCallId: "id", toolName: "lookup", args: JSON.parse(raw) };
    yield stop;
  } });
  const handle = prompt.stream({ envelope }), parts = await collect(handle.fullStream), error = await handle.response.catch(e => e);
  expect(error).toMatchObject({ code: "stream_limit", stage: "normalize" });
  expect(streamFailureDiagnostic(error)).toMatchObject({ rejectSite: "host_terminal", budget: { metric: "retained_bytes" } });
  expect(parts.some(p => p.type.startsWith("tool-call"))).toBe(false);
});

test("bad final arguments after many fragments still discard the whole batch",async()=>{
 const prompt=createStreamingPromptSession({modelId:"test",vision:false,parallel:MANAGED_TOOL_POLICY,produce:async function*(){
  yield {type:"tool-call-streaming-start",toolCallId:"id",toolName:"lookup"};
  for(let i=0;i<12000;i++)yield {type:"tool-call-delta",toolCallId:"id",toolName:"lookup",argsTextDelta:"x"};
  yield {type:"tool-call",toolCallId:"id",toolName:"lookup",args:{}};yield stop;
 }});const h=prompt.stream({envelope});const parts=await collect(h.fullStream);await expect(h.response).rejects.toMatchObject({code:"invalid_stream"});expect(parts.some(p=>p.type.startsWith("tool-call"))).toBe(false);
});

test("compact replay preserves a fast cursor, blocked cursor, late reader and yielded objects",async()=>{
 const replay=replayStream<{type:string;text:string}>({read:p=>({key:p.type,text:p.text}),withText:(p,text)=>({...p,text})});
 const fast=replay.iterable[Symbol.asyncIterator](),slow=replay.iterable[Symbol.asyncIterator]();
 const waiting=fast.next();replay.push({type:"text",text:"A"});const first=(await waiting).value!;
 replay.push({type:"text",text:"B"});expect((await fast.next()).value!.text).toBe("B");
 expect((await slow.next()).value!.text).toBe("AB");expect(first.text).toBe("A");
 const blocked=slow.next();await slow.return?.();expect((await blocked).done).toBe(true);
 replay.push({type:"text",text:"C".repeat(9000)});replay.push({type:"reasoning",text:"D"});replay.close();
 const tail:string[]=[];for(;;){const n=await fast.next();if(n.done)break;tail.push(n.value.text);}expect(tail.join("")).toBe("C".repeat(9000)+"D");
 expect((await collect(replay.iterable)).map(p=>p.text).join("")).toBe("AB"+"C".repeat(9000)+"D");expect(replay.storage().records).toBe(4);
});

test("canonical budget is invariant to JSON framing overhead, yet rejects actual output overflow",()=>{
 const n=createSdkStreamNormalizer();for(let i=0;i<40000;i++)n.next({type:"text-delta",text:"x"});
 n.next({type:"finish",finishReason:"stop",usage:{inputTokens:1,outputTokens:1}});
 expect(n.finish().stream!.counts.semanticOutputBytes).toBe(40000);expect(n.evidence.snapshot().counts.canonicalBytes).toBeGreaterThan(CANONICAL_OUTPUT_MAX_BYTES);
 const tooLarge=createSdkStreamNormalizer();let failure:unknown;try{tooLarge.next({type:"text-delta",text:"x".repeat(CANONICAL_OUTPUT_MAX_BYTES+1)});}catch(e){failure=e;}
 expect(streamFailureDiagnostic(failure)).toMatchObject({budget:{layer:"canonical",metric:"output_bytes",limit:CANONICAL_OUTPUT_MAX_BYTES,measured:CANONICAL_OUTPUT_MAX_BYTES+1}});
});

test("raw SSE audit keeps a long one-byte-fragmented event in bounded storage chunks",()=>{
 const audit=new ProviderStreamAudit("chat",new StreamEvidence());audit.instrumented();
 const frame='data: '+JSON.stringify({choices:[{delta:{content:"x".repeat(70000)},finish_reason:null}]})+'\n\n';
 for(const byte of new TextEncoder().encode(frame))audit.push(Uint8Array.of(byte));
 audit.push(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n'));audit.eof();
 expect(audit.evidence.snapshot()).toMatchObject({providerDoneObserved:true,providerFinishObserved:true,wireToolValidation:"not_applicable",terminalAudit:{boundary:"eof",terminal:"valid",tools:0,invalidJson:0}});
});
