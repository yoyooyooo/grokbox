import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, StreamEvidence, parseRetryAfter, projectFailureSummary, presentFailure, projectProviderHttp, failureSummaryOf, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";

const model = { id: "openai/synthetic", provider: "openai" as const, model: "synthetic", endpoint: "https://offline.invalid/v1", apiKeyRef: "env:KEY", contextWindowTokens: 200000, capabilities: { tools: true } };
const tool = { name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
const chunk = (delta: unknown, finish: unknown = null) => ({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const start = () => chunk({ content: "", tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "lookup", arguments: "" } }] });
const args = (text: string, finish: unknown = null) => chunk({ content: "", tool_calls: [{ index: 0, function: { arguments: text } }] }, finish);
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
async function run(rows: unknown[], response?: () => Response) {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1", systemMessages: [{ role: "system", content: "synthetic root" }], messages: [{ role: "user", content: "synthetic request" }], tools: [tool], options: {} });
  const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
  let httpCalls = 0;
  const fetch = Object.assign(async () => {
    httpCalls++;
    if (response) return response();
    let i = 0; const values = [...rows.map(frame), "data: [DONE]\n\n"];
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i === values.length) c.close(); else c.enqueue(new TextEncoder().encode(values[i++]!)); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const events: InferenceEvent[] = [];
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth, backend = yield* ModelBackend;
    const pin = yield* auth.pin({ apiKeyRef: "env:KEY" });
    const prepared = yield* backend.prepare(model, snapshot);
    return yield* Effect.result(Stream.runForEach(backend.infer({}, prepared, pin.lease), event => Effect.sync(() => { events.push(event); })));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { KEY: "synthetic-no-secret" } })))));
  return { result, events, httpCalls, diagnostic: result._tag === "Failure" ? backendFailureObservation(result.failure) : undefined,
    summary: result._tag === "Failure" ? failureSummaryOf(result.failure) : undefined };
}

describe("provider finish facts settle on the production backend", () => {
  for (const [finish, shape, cause] of [[null, "null", "missing_finish"], ["", "empty", "missing_finish"], [" \t", "whitespace", "missing_finish"], ["private-unknown-value", "unknown", "unsupported_finish_reason"]] as const) {
    test(`${shape} finish with unfinished parameters retains both independent facts`, async () => {
      const out = await run([start(), args('{"q":"unfinished', finish)]);
      expect(out.httpCalls).toBe(1); expect(out.result._tag).toBe("Failure");
      expect(out.diagnostic?.normalizeCause).toBe(cause);
      const evidence = out.diagnostic?.stream;
      expect(evidence?.finishAudit?.lastField?.shape).toBe(shape);
      expect(evidence?.terminalAudit).toMatchObject({ boundary: "eof", tools: 1, invalidJson: 1, terminal: shape === "unknown" ? "unsupported" : "missing" });
      expect(evidence?.wireToolValidation).toBe("rejected");
      expect(evidence?.counts.openTools).toBe(1);
      expect(out.events.some(e => e.type === "backend_finish")).toBe(false);
      expect(JSON.stringify(out.diagnostic)).not.toContain("private-unknown-value");
      expect(JSON.stringify(out.diagnostic)).not.toContain("unfinished");
    });
  }
  test("missing key is distinct from null", () => {
    const e = new StreamEvidence(), audit = new ProviderStreamAudit("chat", e); audit.instrumented();
    audit.push(new TextEncoder().encode(frame({ choices: [{ index: 0, delta: { content: "x" } }] }) + "data: [DONE]\n\n")); audit.eof();
    expect(e.snapshot().finishAudit?.fields).toEqual({ missing: 1 });
    expect(e.snapshot().terminalAudit).toMatchObject({ boundary: "eof", terminal: "missing", tools: 0 });
  });
  test("complete parameters never turn an unknown finish into successful output", async () => {
    const out = await run([start(), args('{"q":"done"}', "unrecognized")]);
    expect(out.result._tag).toBe("Failure");
    expect(out.diagnostic?.normalizeCause).toBe("unsupported_finish_reason");
    expect(out.diagnostic?.stream?.terminalAudit).toMatchObject({ terminal: "unsupported", parseable: 1, invalidJson: 0 });
  });
  test("contradictory terminal reasons are preserved as a conflict", async () => {
    const out = await run([chunk({ content: "x" }, "stop"), chunk({}, "tool_calls")]);
    expect(out.diagnostic?.normalizeCause).toBe("conflicting_finish_reason");
    expect(out.diagnostic?.stream?.finishAudit).toMatchObject({ conflict: true, firstTerminal: { reason: "stop" }, lastTerminal: { reason: "tool_calls" } });
  });
  test("an earlier nonempty unknown finish cannot be erased by a later stop", async () => {
    const out = await run([chunk({ content: "x" }, "unrecognized"), chunk({}, "stop")]);
    expect(out.result._tag).toBe("Failure");
    expect(out.diagnostic?.normalizeCause).toBe("unsupported_finish_reason");
  });
  test("valid stop followed by a blank marker is not silently repaired", async () => {
    const out = await run([chunk({ content: "x" }, "stop"), chunk({}, "")]);
    expect(out.result._tag).toBe("Failure");
    expect(out.diagnostic?.stream?.finishAudit?.lastTerminal?.reason).toBe("stop");
    expect(out.diagnostic?.stream?.finishAudit?.lastField?.shape).toBe("empty");
  });
  test("valid success keeps independently settled audit and normal terminal", async () => {
    const out = await run([start(), args('{"q":"done"}'), chunk({}, "tool_calls")]);
    expect(out.result._tag).toBe("Success");
    const terminal = out.events.at(-1); expect(terminal?.type).toBe("backend_finish");
    if (terminal?.type === "backend_finish") expect(terminal.stream?.terminalAudit).toMatchObject({ boundary: "eof", terminal: "valid", parseable: 1, invalidJson: 0 });
  });
  for (const boundary of ["body_error", "cancelled", "rejected"] as const) test(`${boundary} settles once and cannot be overwritten after dispose`, () => {
    const e = new StreamEvidence(), audit = new ProviderStreamAudit("chat", e); audit.instrumented();
    audit.push(new TextEncoder().encode(frame(start()) + frame(args('{"q":"unfinished'))));
    if (boundary === "body_error") audit.bodyError(); else if (boundary === "cancelled") audit.cancelled(); else audit.settleFailure();
    const before = e.snapshot().terminalAudit;
    expect(before).toMatchObject({ boundary, tools: 1, invalidJson: 1 });
    audit.dispose(); audit.cancelled(); audit.settleFailure();
    expect(e.snapshot().terminalAudit).toEqual(before);
  });
  test("residual SSE is evidence, not an invented dispatched event", () => {
    const e = new StreamEvidence(), audit = new ProviderStreamAudit("chat", e); audit.instrumented();
    audit.push(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "not-dispatched" }, "stop"))}`)); audit.eof();
    expect(e.snapshot().counts.providerEvents).toBeUndefined();
    expect(e.snapshot().terminalAudit).toMatchObject({ boundary: "eof", residualSse: true, terminal: "missing" });
  });
});

describe("safe failure facts and presentation", () => {
  for (const [status, providerCode, category] of [[502, undefined, "upstream_http"], [503, undefined, "upstream_http"], [401, undefined, "upstream_auth"], [403, undefined, "upstream_auth"], [429, "rate_limit_exceeded", "upstream_rate_limit"], [429, "insufficient_quota", "upstream_quota"]] as const) {
    test(`HTTP ${status} / ${category} comes from actual response and reaches presentation`, async () => {
      const out = await run([], () => new Response(JSON.stringify({ error: { message: "DO_NOT_PUBLISH", ...(providerCode ? { code: providerCode, type: providerCode } : { type: "invalid_request_error" }) } }), { status, headers: { "content-type": "application/json", "x-request-id": "upstream-123", "retry-after": "2" } }));
      expect(out.httpCalls).toBe(1); expect(out.summary?.category).toBe(category);
      expect(out.summary?.http).toMatchObject({ status, requestId: { header: "x-request-id", value: "upstream-123" }, retryAfter: { state: "delay", delayMs: 2000 } });
      expect(out.summary?.diagnostic?.stream?.counts.httpCalls).toBe(1);
      expect(JSON.stringify(out.summary)).not.toContain("DO_NOT_PUBLISH");
      const summary = projectFailureSummary({ ...out.summary, progress: { backendAttempts: 1, canonicalEvents: 0 } })!;
      const presentation = presentFailure(summary, { receivedOutput: false, toolsReleased: 0 });
      expect(presentation.templateId).toBe(category);
      expect(presentation.message).toContain("No tools were released by this STEP");
      expect(presentation.message).toContain("No automatic retry");
      expect(presentation.message).not.toContain("not charged");
    });
  }
  test("retry-after rejects free-form text and handles HTTP-date without leaking headers", () => {
    const now = Date.UTC(2026, 8, 16);
    expect(parseRetryAfter(null, now)).toMatchObject({ state: "absent" });
    expect(parseRetryAfter("1.5", now)).toMatchObject({ state: "invalid" });
    expect(parseRetryAfter("-2", now)).toMatchObject({ state: "invalid" });
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toMatchObject({ state: "date", delayMs: 3000 });
    expect(projectProviderHttp({ status: 502, requestId: { header: "x-request-id", value: "Authorization: secret\n" } })?.requestId).toBeUndefined();
  });
  test("projection never invokes getters, preserves invalid summary fallback, and local cause wins", () => {
    let invoked = 0;
    const raw = { version: 1, code: "stream_invalid", phase: "normalize", http: { status: 502 }, get message() { invoked++; throw Error("secret"); } };
    expect(projectFailureSummary(raw)?.category).toBe("stream_invalid"); expect(invoked).toBe(0);
    expect(projectFailureSummary({ version: 99, code: "provider_error", phase: "provider" })).toBeUndefined();
  });
});
