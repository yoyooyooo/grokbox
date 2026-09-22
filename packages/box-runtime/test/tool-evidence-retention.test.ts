import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { providerRuntimeFixture, waitFixtureRows } from "./provider-runtime-fixture.ts";
import { agentTool, contractTools, contractResponse, correctArgs } from "./tool-contract-fixture.ts";
import { observeRuntimeEvents } from "../src/internal/io/journal.node.ts";
import { JOURNAL_LINE_MAX_BYTES } from "../src/internal/io/journal-reader.node.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";

for (const api of ["chat", "responses"] as const) {
  test(`${api}: structured historical name survives the actual journal reader and layered diagnosis`, async () => {
    const fake = Object.assign(async () => contractResponse(api, [{ name: "send_message", args: correctArgs }]), { preconnect: async () => undefined }) as typeof fetch;
    const f = await providerRuntimeFixture(fake, { api });
    try {
      const stepId = randomUUID(), handle = f.session.getExecutor([
        { role: "system", content: "synthetic root" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "historical", toolName: "send_message", args: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "historical", toolName: "send_message", result: { synthetic: true } }] },
        { role: "user", content: "Use only the tools available now." },
      ]).stream({}, stepId, contractTools);
      await expect(handle.response).rejects.toBeInstanceOf(Error);
      await waitFixtureRows(f, stepId);
      const read = await observeRuntimeEvents({ durableRoot: f.durableRoot, runRoot: f.runRoot, source: "host", selector: { agentId: f.agentId, stepId } });
      expect(read.state).toBe("present");
      const cli = projectSendOutcome({ agentId: f.agentId, stepId, entries: [], alerts: [], truncated: false, runtimeEvents: read.events });
      expect(cli.runtimeFailure?.diagnostic?.streams?.backend?.toolIdentity?.firstMismatch?.history).toBe("structured_call");
      expect(cli.runtimeFailure?.presentation?.message).toContain("No automatic retry was made");
      expect(cli.runtimeFailure?.presentation?.replayAuthorized).toBe(false);
    } finally { await f.stop(); }
  }, 10000);

  test(`${api}: full evidence tails stay under journal line limits and do not hide a rejected batch`, async () => {
    const calls = [...Array.from({ length: 16 }, () => ({ name: agentTool.name, args: correctArgs })), { name: "send_message", args: correctArgs }];
    const fake = Object.assign(async () => contractResponse(api, calls, "synthetic progress", "frames"), { preconnect: async () => undefined }) as typeof fetch;
    const f = await providerRuntimeFixture(fake, { api });
    try {
      const stepId = randomUUID(), handle = f.session.getExecutor([{ role: "system", content: "synthetic root" }, { role: "user", content: "synthetic" }]).stream({}, stepId, contractTools);
      await expect(handle.response).rejects.toBeInstanceOf(Error);
      let released = 0;
      try { for await (const part of handle.fullStream) if (part.type.startsWith("tool-call")) released++; } catch { /* expected failure */ }
      expect(released).toBe(0);
      const rows = await waitFixtureRows(f, stepId);
      for (const row of rows) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(JOURNAL_LINE_MAX_BYTES);
      const read = await observeRuntimeEvents({ durableRoot: f.durableRoot, runRoot: f.runRoot, source: "host", selector: { agentId: f.agentId, stepId } });
      const cli = projectSendOutcome({ agentId: f.agentId, stepId, entries: [], alerts: [], truncated: false, runtimeEvents: read.events });
      expect(cli.state).toBe("failed");
      expect(cli.runtimeFailure?.diagnostic?.streams?.host?.counts.hostToolsReleased).toBe(0);
      const provider = cli.runtimeFailure?.diagnostic?.streams?.backend;
      expect(provider?.toolIdentity?.tail).toHaveLength(8);
      expect(provider?.tail).toHaveLength(32);
      expect(provider?.toolIdentity?.firstMismatch?.relation).toBe("unmatched");
    } finally { await f.stop(); }
  }, 10000);
}
