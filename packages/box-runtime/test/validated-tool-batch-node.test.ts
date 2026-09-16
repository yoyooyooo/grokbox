import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("packed Node Host accepts a complete batch and rejects a broken batch without partial release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batch-node-"));
  try {
    const outfile = join(dir, "probe.mjs");
    await build({ absWorkingDir: join(import.meta.dir, "../../.."), bundle: true, platform: "node", target: "node20", format: "esm", outfile, logLevel: "silent",
      stdin: { resolveDir: join(import.meta.dir, "../../.."), sourcefile: "synthetic-batch-probe.ts", contents: `
import { createStreamingPromptSession, MANAGED_TOOL_POLICY } from "./packages/box-runtime/src/internal/host/session.ts";
import { buildHostEnvelope } from "./packages/box-runtime/src/internal/host/context-codec.ts";
const results = [];
for (const bad of [false, true]) {
  let attempts = 0;
  const session = createStreamingPromptSession({modelId:"synthetic/model",vision:false,parallel:MANAGED_TOOL_POLICY,produce:async function*(){
    attempts++;
    yield {type:"tool-call",toolCallId:"a",toolName:"read",args:{n:1}};
    yield {type:"tool-call",toolCallId:"b",toolName:"read",args:{n:2}};
    if (bad) yield {type:"tool-call-streaming-start",toolCallId:"bad",toolName:"read"};
    yield {type:"finish",reason:"stop",usage:{promptTokens:1,completionTokens:1,totalTokens:2}};
  }});
  const handle=session.stream({envelope:buildHostEnvelope([{role:"user",content:"synthetic"}],[{name:"read",inputSchema:{type:"object"}}])});
  const released=[]; for await (const p of handle.fullStream) if(p.type.startsWith("tool-call")) released.push(p);
  const outcome=await handle.response.then(r=>r.finishReason,e=>e.code);
  results.push({bad,outcome,attempts,released:released.filter(p=>p.type==="tool-call").map(p=>p.toolCallId)});
}
console.log(JSON.stringify({runtime:process.version,results}));
` } });
    const child = spawnSync("node", [outfile], { env: { PATH: process.env.PATH, HOME: dir }, cwd: dir, encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    const output = JSON.parse(child.stdout);
    expect(output.results).toEqual([
      { bad: false, outcome: "tool-calls", attempts: 1, released: ["a", "b"] },
      { bad: true, outcome: "invalid_stream", attempts: 1, released: [] },
    ]);
    expect(child.stderr).not.toContain("MaxListenersExceededWarning");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);
