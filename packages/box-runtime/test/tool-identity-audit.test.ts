import { describe, expect, test } from "bun:test";
import { StreamEvidence, projectStreamSummary, projectToolIdentityAudit, streamFailureDiagnostic, failureSummaryFromObservation, presentFailure } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { ToolIdentityObserver } from "../src/internal/backends/tool-identity-audit.ts";
import { createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";

const request = (names: string[]) => JSON.stringify({ tools: names.map(name => ({ type: "function", function: { name } })) });
const encoder = new TextEncoder();
const frame = (name: string) => encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "private-call", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`);

describe("tool declaration and identity witnesses", () => {
  test("sent Chat/Responses declarations compare the actual name multiset", () => {
    const evidence = new StreamEvidence(), audit = new ToolIdentityObserver(["lookup", "finish"], evidence);
    expect(audit.request(request(["finish", "lookup"]), "chat")).toBe(true);
    expect(evidence.snapshot().toolIdentity?.sent?.matchesDeclared).toBe(true);
    expect(audit.request(request(["lookup", "lookup"]), "chat")).toBe(false);
    expect(evidence.snapshot().toolIdentity?.sent?.matchesDeclared).toBe(false);
    expect(audit.request(JSON.stringify({ tools: [{ type: "function", name: "lookup" }, { type: "function", name: "finish" }] }), "responses")).toBe(true);
    expect(audit.request("{}", "chat")).toBe(false);
    expect(audit.request("{", "chat")).toBe(false);
  });
  test("provider and SDK identities are linked without retaining literal names or IDs", () => {
    const evidence = new StreamEvidence(), identity = new ToolIdentityObserver(["lookup"], evidence);
    identity.request(request(["lookup"]), "chat");
    const wire = new ProviderStreamAudit("chat", evidence, identity);
    wire.instrumented(); wire.push(frame("unavailable_tool"));
    const normalizer = createSdkStreamNormalizer({ declaredTools: new Set(["lookup"]), evidence, toolIdentity: identity });
    let failure: unknown;
    try { normalizer.next({ type: "tool-input-start", id: "private-call", toolName: "unavailable_tool" }); } catch (e) { failure = e; }
    const diagnostic = streamFailureDiagnostic(failure);
    expect(diagnostic).toMatchObject({ normalizeCause: "undeclared_tool", rejectSite: "sdk_tool", declaredToolMatch: false });
    const observed = diagnostic!.stream!.toolIdentity!;
    expect(observed.sent?.matchesDeclared).toBe(true);
    expect(observed.firstMismatch).toMatchObject({ layer: "provider", relation: "unmatched", nameDigest: sha256Text("unavailable_tool") });
    expect(observed.tail.at(-1)).toMatchObject({ layer: "sdk", wireNameMatched: true });
    expect(JSON.stringify(observed)).not.toContain("unavailable_tool");
    expect(JSON.stringify(observed)).not.toContain("private-call");
    expect(projectStreamSummary(evidence.snapshot())?.toolIdentity).toEqual(observed);
    wire.dispose(); identity.dispose();
  });
  for (const [name, relation] of [["LOOKUP", "case_only"], ["functions.lookup", "qualified"], ["look", "strict_prefix"], ["other", "unmatched"]] as const) {
    test(`${relation} is evidence only and never repairs ${name}`, () => {
      const evidence = new StreamEvidence(), identity = new ToolIdentityObserver(["lookup"], evidence);
      const normalizer = createSdkStreamNormalizer({ declaredTools: new Set(["lookup"]), evidence, toolIdentity: identity });
      expect(() => normalizer.next({ type: "tool-input-start", id: "c", toolName: name })).toThrow();
      expect(evidence.snapshot().toolIdentity?.firstMismatch?.relation).toBe(relation);
    });
  }
  test("name changes and SDK rewrites are observable; tail and retained state stay bounded", () => {
    const evidence = new StreamEvidence(), identity = new ToolIdentityObserver(["lookup"], evidence);
    identity.provider("call", "look"); identity.provider("call", "lookup"); identity.sdk("call", "other");
    expect(evidence.snapshot().toolIdentity?.tail[1]?.phase).toBe("changed");
    expect(evidence.snapshot().toolIdentity?.tail[2]?.wireNameMatched).toBe(false);
    for (let i = 0; i < 200; i++) identity.sdk(`call-${i}`, "lookup");
    const result = evidence.snapshot().toolIdentity!;
    expect(result.tail).toHaveLength(8); expect(result.truncated).toBe(true);
    expect(result.firstMismatch?.relation).toBe("strict_prefix");
    expect(JSON.stringify(result).length).toBeLessThan(4000);
  });
  test("projection never invokes getters or admits raw properties", () => {
    let getters = 0;
    const d = "a".repeat(64);
    const dirty = { version: 1, declared: { count: 1, digest: d, raw: "secret" }, observed: 1, truncated: false,
      firstMismatch: { layer: "provider", relation: "unmatched", phase: "first", nameDigest: d, rawName: "secret", get callDigest() { getters++; throw Error("secret"); } },
      tail: Array.from({ length: 100 }, () => ({ layer: "sdk", relation: "exact", phase: "first", rawName: "secret" })),
      get sent() { getters++; throw Error("secret"); }, raw: "secret" };
    const projected = projectToolIdentityAudit(dirty)!;
    expect(getters).toBe(0); expect(projected.tail).toHaveLength(8); expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(projectToolIdentityAudit({ version: 1, declared: { count: 129, digest: d }, observed: 0, truncated: false, tail: [] })).toBeUndefined();
  });
  test("unknown-tool presentation distinguishes this STEP from earlier side effects", () => {
    const summary = failureSummaryFromObservation({ failureCode: "stream_invalid", phase: "normalize", diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "sdk_tool" } });
    const shown = presentFailure(summary!, { toolsReleased: 0 });
    expect(shown.message).toContain("tool name that was not declared for this STEP");
    expect(shown.message).toContain("Earlier STEPs may already have changed state");
    expect(shown.replayAuthorized).toBe(false);
  });
});
