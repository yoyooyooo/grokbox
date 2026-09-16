import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectControlEvent } from "../src/internal/io/journal.node.ts";
import { providerRuntimeFixture, waitFixtureRows, syntheticTool, successfulProviderResponse } from "./provider-runtime-fixture.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";
const enabled = { GROKBOX_MODELD_PROVIDER_RECOVERY: "pre-output-http", GROKBOX_MODELD_RECOVERY_EXTRA_REQUESTS: "2", GROKBOX_MODELD_RECOVERY_WINDOW_MS: "5000", GROKBOX_MODELD_RECOVERY_BASE_DELAY_MS: "1", GROKBOX_MODELD_RECOVERY_MAX_DELAY_MS: "10" };
for (const api of ["chat", "responses"] as const) test(`production ${api} 502 recovery: disk attempt claims, one tool batch, visible query progress`, async () => {
  const bodies: string[] = [];
  const fetch = Object.assign(async (_url: any, init?: RequestInit) => { bodies.push(String(init?.body)); return bodies.length === 1
    ? new Response('{"error":{"message":"temporary","type":"invalid_request_error"}}', { status: 502, headers: { "content-type": "application/json" } }) : successfulProviderResponse(api); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { api, env: enabled });
  try {
    const stepId = randomUUID(), executor = f.session.getExecutor([{ role: "system", content: "root" }, { role: "user", content: "q" }]);
    const handle = executor.stream({}, stepId, [syntheticTool]);
    const response = await handle.response; expect(response.finishReason).toBe("tool-calls");
    const released: unknown[] = []; for await (const event of handle.fullStream) if (event.type === "tool-call") released.push(event);
    expect(released).toHaveLength(1); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    const rows = await waitFixtureRows(f, stepId), modeld = rows.find(e=>e.name==="model_step_terminal"&&e.stepId===stepId)!;
    expect(modeld).toMatchObject({ outcome: "ok", backendAttempts: 2, recovery: { phase: "succeeded", stopReason: "success", settlementRecorded: true } });
    expect(modeld.recovery.attempts.map((a: any)=>a.state)).toEqual(["failed", "completed"]);
    const progress = rows.filter(e=>e.name==="model_recovery_progress"); expect(progress.some(e=>e.recovery.phase==="waiting")).toBe(true);
    expect(progress.every(e=>projectControlEvent(e)!==null)).toBe(true);
    const outcome = projectSendOutcome({agentId:f.agentId,stepId,entries:[],alerts:[],truncated:false,runtimeEvents:rows});
    expect(outcome.runtimeRecovery?.state?.phase).toBe("succeeded"); expect(outcome.runtimeFailure).toBeNull();
    await executor.stream({},stepId,[syntheticTool]).response.catch(()=>undefined);
    expect(bodies).toHaveLength(2);
  } finally { await f.stop(); }
}, 12000);

test("same logical STEP cannot retry after the model selection changes while its HTTP call is in flight", async () => {
  let calls=0; let change:()=>Promise<void>=async()=>{};
  const fetch=Object.assign(async()=>{calls++;await change();return new Response('{}',{status:503,headers:{'content-type':'application/json'}});},{preconnect:async()=>undefined}) as typeof globalThis.fetch;
  const f=await providerRuntimeFixture(fetch,{env:enabled});change=f.changeModel;
  try {
    const stepId=randomUUID(),handle=f.session.getExecutor([{role:"system",content:"root"},{role:"user",content:"q"}]).stream({},stepId,[syntheticTool]);
    const error=await handle.response.catch(e=>e);expect(error).toBeInstanceOf(Error);expect(calls).toBe(1);
    const rows=await waitFixtureRows(f,stepId),modeld=rows.find(e=>e.name==="model_step_terminal"&&e.stepId===stepId)!;
    expect(modeld.failureCode).toBe("selection_mismatch");expect(modeld.recovery?.stopReason??modeld.failureSummary?.recovery?.stopReason).toBe("configuration_changed");
    expect(rows.find(e=>e.name==="host_normalized_terminal"&&e.stepId===stepId)?.toolCallCount).toBe(0);
  } finally { await f.stop(); }
});

test("cancelling while recovery waits never replays the STEP or releases tool material", async () => {
  let calls=0;
  const fetch=Object.assign(async()=>{calls++;return new Response('{}',{status:502,headers:{'content-type':'application/json','retry-after':'3'}});},{preconnect:async()=>undefined}) as typeof globalThis.fetch;
  const f=await providerRuntimeFixture(fetch,{env:enabled});const abort=new AbortController();
  try {
    const stepId=randomUUID(),handle=f.session.getExecutor([{role:"system",content:"root"},{role:"user",content:"q"}]).stream({abortSignal:abort.signal},stepId,[syntheticTool]);
    const until=Date.now()+3000;let waiting=false;
    while(Date.now()<until){waiting=(await f.rows()).some(e=>e.name==="model_recovery_progress"&&e.stepId===stepId&&e.recovery.phase==="waiting");if(waiting)break;await new Promise(r=>setTimeout(r,10));}
    expect(waiting).toBe(true);abort.abort();await handle.response.catch(()=>undefined);
    const rows=await waitFixtureRows(f,stepId);expect(calls).toBe(1);
    expect(rows.find(e=>e.name==="host_normalized_terminal"&&e.stepId===stepId)?.toolCallCount).toBe(0);
  } finally { abort.abort(); await f.stop(); }
}, 8000);
