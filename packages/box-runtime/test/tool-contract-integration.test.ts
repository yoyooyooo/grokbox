import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { streamFailureDiagnostic, type GenerationOptions, type NormalizeCause, type JsonValue, type ToolCall } from "@grokbox/runtime-kernel/contract";
import { providerRuntimeFixture, waitFixtureRows } from "./provider-runtime-fixture.ts";
import { agentTool, contractTools, contractResponse, correctArgs, type FixtureCall } from "./tool-contract-fixture.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";
import { diagnoseExecution } from "@grokbox/runtime-kernel/alerts";
import type { StreamHandle, StreamPart } from "../src/internal/host/session.ts";

const root = [{ role: "system", content: "synthetic root" }, { role: "user", content: "Use SendToAgent with target_id and message. There is no send_message." }];
const recovery = { GROKBOX_MODELD_PROVIDER_RECOVERY: "pre-output-http", GROKBOX_MODELD_RECOVERY_EXTRA_REQUESTS: "2", GROKBOX_MODELD_RECOVERY_WINDOW_MS: "3000", GROKBOX_MODELD_RECOVERY_BASE_DELAY_MS: "1", GROKBOX_MODELD_RECOVERY_MAX_DELAY_MS: "10" };
async function consume(handle: StreamHandle) {
  const parts: StreamPart[] = []; let error: unknown;
  try { for await (const part of handle.fullStream) parts.push(part); } catch (e) { error = e; }
  const response = await handle.response.catch(e => { error = e; return undefined; });
  return { parts, response, error };
}
const cases: Array<{ name: string; calls: FixtureCall[]; choice?: GenerationOptions["toolChoice"]; text?: string; cause?: NormalizeCause }> = [
  { name: "correct", calls: [{ name: agentTool.name, args: correctArgs }] },
  { name: "unknown", calls: [{ name: "send_message", args: correctArgs }], cause: "undeclared_tool" },
  { name: "text then unknown", text: "progress", calls: [{ name: "send_message", args: correctArgs }], cause: "undeclared_tool" },
  { name: "valid then unknown batch", calls: [{ name: agentTool.name, args: correctArgs }, { name: "send_message", args: correctArgs }], cause: "undeclared_tool" },
  { name: "none rejects calls", choice: "none", calls: [{ name: agentTool.name, args: correctArgs }], cause: "tool_choice_mismatch" },
  { name: "forced rejects other declared", choice: { type: "tool", toolName: agentTool.name }, calls: [{ name: "OtherTool", args: {} }], cause: "tool_choice_mismatch" },
  { name: "required missing call", choice: "required", text: "answer", calls: [], cause: "tool_choice_mismatch" },
  { name: "forced missing call", choice: { type: "tool", toolName: agentTool.name }, text: "answer", calls: [], cause: "tool_choice_mismatch" },
  { name: "none text cannot synthesize delivery", choice: "none", text: "answer", calls: [] },
];
for (const api of ["chat", "responses"] as const) {
  for (const scenario of cases) test(`production ${api}: ${scenario.name} across disk/Unix/Host/diagnosis`, async () => {
    let http = 0, body: Record<string, any> = {};
    const fake = Object.assign(async (_url: unknown, init?: RequestInit) => { http++; body = JSON.parse(String(init?.body)); return contractResponse(api, scenario.calls, scenario.text); }, { preconnect: async () => undefined }) as typeof fetch;
    const f = await providerRuntimeFixture(fake, { api, env: recovery });
    try {
      const stepId = randomUUID(), handle = f.session.getExecutor(root).stream({}, stepId, contractTools, { toolChoice: scenario.choice });
      const result = await consume(handle), rows = await waitFixtureRows(f, stepId);
      const host = rows.find(e => e.name === "host_normalized_terminal" && e.stepId === stepId)!;
      expect(http).toBe(1); expect(host.diagnostic.stream.hostToolPolicy).toBe("validated-batch");
      const definitions = body.tools.map((t: any) => api === "chat" ? t.function : t);
      expect(definitions.find((t: any) => t.name === agentTool.name)?.parameters).toEqual(agentTool.inputSchema);
      expect(JSON.stringify(body)).toContain(root[1]!.content);
      if (scenario.cause) {
        expect(result.error).toBeInstanceOf(Error);
        expect(streamFailureDiagnostic(result.error)?.normalizeCause).toBe(scenario.cause);
        expect(result.parts.filter(p => p.type.startsWith("tool-call"))).toEqual([]);
        expect(host.toolCallCount).toBe(0);
        const cli = projectSendOutcome({ agentId: f.agentId, stepId, entries: [], alerts: [], truncated: false, runtimeEvents: rows });
        const core = diagnoseExecution(rows, { agentId: f.agentId, stepId });
        expect(cli.runtimeFailure?.diagnostic).toEqual("diagnostic" in core ? core.diagnostic : undefined);
        expect(cli.runtimeFailure?.diagnostic?.streams).toMatchObject({
          backend: { toolValidationScope: "structure_only", toolIdentity: { sent: { matchesDeclared: true }, contract: { schemasMatch: true, choiceMatch: true } } },
          wire: { version: 1 }, host: { toolBatchState: "discarded", counts: { hostToolsReleased: 0 } },
        });
        expect(cli.runtimeFailure?.presentation?.replayAuthorized).toBe(false);
        if (scenario.cause === "undeclared_tool") expect(cli.runtimeFailure?.diagnostic?.streams?.backend?.toolIdentity?.firstMismatch?.history).toBe("not_observed");
      } else {
        expect(result.error).toBeUndefined(); expect(host.toolCallCount).toBe(scenario.calls.length);
      }
    } finally { await f.stop(); }
  }, 10000);

  test(`production ${api}: failed STEP is not replayed; explicit correction proceeds in a fresh STEP`, async () => {
    let http = 0, corrected = false; const bodies: string[] = [];
    const fake = Object.assign(async (_url: unknown, init?: RequestInit) => { http++; bodies.push(String(init?.body)); return contractResponse(api, [{ name: corrected ? agentTool.name : "send_message", args: correctArgs }]); }, { preconnect: async () => undefined }) as typeof fetch;
    const f = await providerRuntimeFixture(fake, { api, env: recovery });
    try {
      const executor = f.session.getExecutor(root), before = executor.getState(), step = randomUUID();
      expect((await consume(executor.stream({}, step, contractTools))).error).toBeInstanceOf(Error);
      expect(executor.getState()).toEqual(before);
      await consume(executor.stream({}, step, contractTools)); expect(http).toBe(1);
      corrected = true; executor.appendMessages([{ role: "user", content: "CORRECTION_SENTINEL: use the declared schema." }]);
      const next = await consume(executor.stream({}, randomUUID(), contractTools));
      expect(next.error).toBeUndefined(); expect(http).toBe(2);
      expect(bodies[1]).toContain("CORRECTION_SENTINEL"); expect(bodies[1]).not.toContain("undeclared_tool");
      expect(next.parts.filter(p => p.type === "tool-call")).toHaveLength(1);
    } finally { await f.stop(); }
  }, 10000);

  test(`production ${api}: a tool recommended in text is still unavailable when absent from the STEP declaration`, async () => {
    const offered = contractTools.filter(tool => tool.name !== agentTool.name);
    let http = 0; const bodies: Record<string, any>[] = [];
    const fake = Object.assign(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); http++;
      return contractResponse(api, [{ name: agentTool.name, args: correctArgs }]);
    }, { preconnect: async () => undefined }) as typeof fetch;
    const f = await providerRuntimeFixture(fake, { api, env: recovery });
    try {
      const executor = f.session.getExecutor(root);
      const audits: unknown[] = [];
      for (let ordinal = 0; ordinal < 2; ordinal++) {
        if (ordinal) executor.appendMessages([{ role: "user", content: "CORRECTION_ONLY: use SendToAgent, not send_message." }]);
        const stepId = randomUUID(), result = await consume(executor.stream({}, stepId, offered));
        const events = await waitFixtureRows(f, stepId);
        const terminal = events.find(e => e.name === "model_step_terminal" && e.stepId === stepId)!;
        const witness = terminal.stream.toolIdentity;
        expect(result.error).toBeInstanceOf(Error);
        expect(streamFailureDiagnostic(result.error)?.normalizeCause).toBe("undeclared_tool");
        expect(result.parts.filter(part => part.type.startsWith("tool-call"))).toEqual([]);
        expect(events.find(e => e.name === "host_normalized_terminal" && e.stepId === stepId)?.toolCallCount).toBe(0);
        expect(witness).toMatchObject({ sent: { matchesDeclared: true },
          firstMismatch: { relation: "unmatched", nameLength: agentTool.name.length, history: "not_observed" } });
        expect(witness.tail.find((entry: any) => entry.layer === "sdk")).toMatchObject({ wireNameMatched: true });
        audits.push(witness.declared);
        expect(http).toBe(ordinal + 1); // New explicit STEP, never an automatic retry.
      }
      expect(audits[0]).toEqual(audits[1]);
      for (const body of bodies) {
        expect(body.tools.map((tool: any) => api === "chat" ? tool.function.name : tool.name)).not.toContain(agentTool.name);
        expect(JSON.stringify(body)).toContain(root[1]!.content);
      }
      expect(JSON.stringify(bodies[1])).toContain("CORRECTION_ONLY");
    } finally { await f.stop(); }
  }, 10000);

  for (const wrong of [{ recipient: "target", content: "text" }, { target_id: 7, message: false }] as JsonValue[]) {
    test(`production ${api}: JSON-valid wrong args are NOT claimed schema-checked or executed (${JSON.stringify(wrong)})`, async () => {
      const fake = Object.assign(async () => contractResponse(api, [{ name: agentTool.name, args: wrong }]), { preconnect: async () => undefined }) as typeof fetch;
      const f = await providerRuntimeFixture(fake, { api });
      try {
        const stepId = randomUUID(), result = await consume(f.session.getExecutor(root).stream({}, stepId, contractTools));
        expect(result.error).toBeUndefined();
        const call = result.parts.find((p): p is ToolCall => p.type === "tool-call")!;
        expect(call.args).toEqual(wrong);
        const rows = await waitFixtureRows(f, stepId);
        expect(rows.find(e => e.name === "host_normalized_terminal" && e.stepId === stepId)?.diagnostic.stream.toolValidationScope).toBe("structure_only");
        // Independent synthetic native-shaped validation; no real tool/recipient
        // is contacted. This proves the fixture's pre-effect boundary only.
        let effects = 0;
        const nativeConsumer = (input: any) => {
          if (typeof input.target_id !== "string" || typeof input.message !== "string") return { ok: false, error: "invalid_arguments" };
          effects++; return { ok: true };
        };
        expect(nativeConsumer(call.args)).toEqual({ ok: false, error: "invalid_arguments" }); expect(effects).toBe(0);
      } finally { await f.stop(); }
    }, 10000);
  }
}
