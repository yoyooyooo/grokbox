import { expect, test } from "bun:test";
import { StreamEvidence, projectToolIdentityAudit, streamFailureDiagnostic, failureSummaryFromObservation, presentFailure, type GenerationOptions, type PromptMessage } from "@grokbox/runtime-kernel/contract";
import { ToolIdentityObserver } from "../src/internal/backends/tool-identity-audit.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";
import { guardEgress } from "../src/internal/backends/ai-sdk.ts";

const schema = { type: "object", properties: { target_id: { type: "string" }, message: { type: "string" } }, required: ["target_id", "message"], additionalProperties: false };
const tool = { name: "SendToAgent", inputSchema: schema };
function body(api: "chat" | "responses") {
  return { model: "fixture", tools: api === "chat" ? [{ type: "function", function: { name: tool.name, parameters: structuredClone(schema) } }]
    : [{ type: "function", name: tool.name, parameters: structuredClone(schema) }], tool_choice: "required" } as Record<string, any>;
}
for (const api of ["chat", "responses"] as const) {
  for (const fault of ["valid", "key-order", "schema", "missing-schema", "name", "choice", "forced-choice-name", "duplicate", "malformed"] as const) {
    test(`${api} actual egress guard: ${fault} (no request on declaration drift)`, async () => {
      const evidence = new StreamEvidence(), request = body(api);
      const choice: GenerationOptions["toolChoice"] = fault === "forced-choice-name" ? { type: "tool", toolName: tool.name } : "required";
      const identity = new ToolIdentityObserver([tool.name], evidence, { tools: [tool], toolChoice: choice });
      const definition = api === "chat" ? request.tools[0].function : request.tools[0];
      if (fault === "schema") definition.parameters.properties = { recipient: { type: "string" }, content: { type: "string" } };
      if (fault === "missing-schema") delete definition.parameters;
      if (fault === "key-order") definition.parameters = { additionalProperties: false, required: [...schema.required], properties: { message: { type: "string" }, target_id: { type: "string" } }, type: "object" };
      if (fault === "name") definition.name = "send_message";
      if (fault === "duplicate") request.tools.push(structuredClone(request.tools[0]));
      if (fault === "choice") request.tool_choice = "none";
      if (fault === "forced-choice-name") request.tool_choice = api === "chat" ? { type: "function", function: { name: "OtherTool" } } : { type: "function", name: "OtherTool" };
      let calls = 0;
      const fake = Object.assign(async () => { calls++; return new Response("{}", { headers: { "content-type": "application/json" } }); }, { preconnect: async () => undefined }) as typeof fetch;
      const audit = new ProviderStreamAudit(api, evidence, identity);
      const guarded = guardEgress(fake, audit, identity, api, "standard", "fixture");
      let error: unknown;
      try { await guarded("https://offline.invalid/v1", { body: fault === "malformed" ? "{" : JSON.stringify(request) }); } catch (e) { error = e; }
      const valid = fault === "valid" || fault === "key-order";
      expect(calls).toBe(valid ? 1 : 0);
      if (valid) {
        expect(error).toBeUndefined();
        expect(evidence.snapshot().toolIdentity?.contract).toMatchObject({ schemasMatch: true, choiceMatch: true });
      } else {
        const cause = fault === "malformed" ? "reasoning_request_conflict" : fault === "schema" || fault === "missing-schema" ? "tool_schema_declaration_mismatch"
          : fault === "choice" || fault === "forced-choice-name" ? "tool_choice_declaration_mismatch" : "tool_declaration_mismatch";
        expect(streamFailureDiagnostic(error)?.normalizeCause).toBe(cause);
      }
      if (fault === "schema") expect(evidence.snapshot().toolIdentity?.sent?.matchesDeclared).toBe(true);
      expect(JSON.stringify(evidence.snapshot())).not.toContain("target_id");
      expect(JSON.stringify(evidence.snapshot())).not.toContain("SendToAgent");
      audit.dispose(); identity.dispose();
    });
  }
}

for (const [cause, phrase] of [["tool_schema_declaration_mismatch", "tool schemas did not match"], ["tool_choice_declaration_mismatch", "tool choice did not match"]] as const) {
  test(`failure presentation names ${cause}`, () => {
    const summary = failureSummaryFromObservation({ failureCode: "invalid_stream", phase: "normalize", diagnostic: { normalizeCause: cause } });
    expect(summary).toBeDefined();
    expect(presentFailure(summary!).message).toContain(phrase);
  });
}

test("zero-tool none is equivalent to SDK omission; malformed reread cannot retain stale success", () => {
  const evidence = new StreamEvidence(), identity = new ToolIdentityObserver([], evidence, { tools: [], toolChoice: "none" });
  expect(identity.request("{}", "chat")).toBe(true);
  expect(identity.request("{", "chat")).toBe(false);
  expect(evidence.snapshot().toolIdentity?.sent).toBeUndefined();
  expect(evidence.snapshot().toolIdentity?.contract?.choiceMatch).toBeUndefined();
});

for (const sdkBeforeChange of [true, false]) test(`provider name changes never manufacture SDK rewrite evidence (early SDK=${sdkBeforeChange})`, () => {
  const evidence = new StreamEvidence(), identity = new ToolIdentityObserver([tool.name], evidence);
  identity.provider("c", "SendTo");
  if (sdkBeforeChange) identity.sdk("c", "SendTo");
  identity.provider("c", "Agent");
  if (!sdkBeforeChange) identity.sdk("c", "SendTo");
  const sdk = evidence.snapshot().toolIdentity!.tail.find(e => e.layer === "sdk")!;
  expect(sdk.wireComparison).toBe("identity_changed"); expect(sdk.wireNameMatched).toBeUndefined();
});

test("stable provider identity permits a real mismatch observation, not inferred blame", () => {
  const evidence = new StreamEvidence(), identity = new ToolIdentityObserver([tool.name], evidence);
  identity.provider("c", tool.name); identity.sdk("c", "send_message");
  expect(evidence.snapshot().toolIdentity?.tail.at(-1)).toMatchObject({ wireComparison: "stable_identity", wireNameMatched: false });
});

test("structured call history is bounded and distinct from an explicit textual correction", () => {
  const history: PromptMessage[] = [{ role: "user", content: "There is no send_message; use SendToAgent." },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "OldTool", args: {} }] }];
  const evidence = new StreamEvidence(), identity = new ToolIdentityObserver([tool.name], evidence, { messages: history });
  identity.provider("one", "send_message"); identity.provider("two", "OldTool");
  expect(evidence.snapshot().toolIdentity?.tail.map(e => e.history)).toEqual(["not_observed", "structured_call"]);
  expect(JSON.stringify(evidence.snapshot())).not.toContain("OldTool");
  const many: PromptMessage[] = [{ role: "assistant", content: Array.from({ length: 200 }, (_, i) => ({ type: "tool-call", toolCallId: `old-${i}`, toolName: `name-${i}`, args: {} })) }];
  const bounded = new ToolIdentityObserver([tool.name], evidence, { messages: many });
  bounded.sdk("c", "unseen");
  expect(evidence.snapshot().toolIdentity).toMatchObject({ historyTruncated: true, firstMismatch: { history: "unknown" } });
});

test("new diagnostic fields neither invoke getters nor retain schemas/payloads", () => {
  let reads = 0;
  const bad = { version: 1, declared: { count: 1, digest: "a".repeat(64) }, observed: 1, truncated: false,
    contract: { schemaDigest: "b".repeat(64), requestedChoice: "tool", rawSchema: schema, get sentChoice() { reads++; return "none"; } },
    tail: [{ layer: "sdk", relation: "unmatched", phase: "first", wireComparison: "identity_changed", wireNameMatched: false,
      get history() { reads++; return "structured_call"; }, raw: "PRIVATE" }],
  };
  const projected = projectToolIdentityAudit(bad)!;
  expect(reads).toBe(0); expect(projected.tail[0]?.wireNameMatched).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain("PRIVATE"); expect(JSON.stringify(projected)).not.toContain("target_id");
  const invalidQualifier = projectToolIdentityAudit({ ...bad, tail: [{ layer: "sdk", relation: "unmatched", phase: "first", wireComparison: "invented", wireNameMatched: false }] });
  expect(invalidQualifier?.tail[0]?.wireNameMatched).toBeUndefined();
});
