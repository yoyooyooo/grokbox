import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, streamFailureDiagnostic, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { contractResponse, contractTools, correctArgs } from "./tool-contract-fixture.ts";

async function run(api: "chat" | "responses", response: () => Response) {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "synthetic root" }], messages: [{ role: "user", content: "synthetic" }], tools: contractTools, options: {} });
  let http = 0, error: unknown; const events: InferenceEvent[] = [];
  const fake = Object.assign(async () => { http++; return response(); }, { preconnect: async () => undefined }) as typeof fetch;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth, backend = yield* ModelBackend, pinned = yield* auth.pin({ apiKeyRef: "env:KEY" });
    const prepared = yield* backend.prepare({ id: "fixture/model", provider: api === "chat" ? "openai-chat" : "openai-responses", model: "fixture", endpoint: "https://fixture.invalid/v1", apiKeyRef: "env:KEY", capabilities: { tools: true } }, { ...body, snapshotDigest: computeSnapshotDigest(body) });
    yield* Stream.runForEach(backend.infer({}, prepared, pinned.lease), e => Effect.sync(() => { events.push(e); })).pipe(Effect.catch(e => Effect.sync(() => { error = e; })));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch: fake, env: { KEY: "synthetic-only" } })))));
  return { events, http, error, diagnostic: streamFailureDiagnostic(error) };
}
for (const api of ["chat", "responses"] as const) for (const framing of ["all", "frames", "bytes"] as const) {
  test(`production ${api} ${framing}: exact identity and schemas survive framing`, async () => {
    const result = await run(api, () => contractResponse(api, [{ name: "SendToAgent", args: correctArgs }], "", framing));
    expect(result.http).toBe(1); expect(result.error).toBeUndefined();
    const finish = result.events.find(e => e.type === "backend_finish");
    expect(finish?.stream?.toolIdentity).toMatchObject({ contract: { schemasMatch: true, choiceMatch: true } });
    expect(finish?.stream?.toolIdentity?.tail.filter(e => e.layer === "sdk").every(e => e.wireComparison === "stable_identity" && e.wireNameMatched === true)).toBe(true);
  });
}
for (const framing of ["all", "frames", "bytes"] as const) test(`actual Chat name fragments remain rejected without false SDK blame (${framing})`, async () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  const rows = [chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "SendTo", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "Agent", arguments: JSON.stringify(correctArgs) } }] }), chunk({}, "tool_calls")];
  const result = await run("chat", () => {
    const text = rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n";
    const enc = new TextEncoder(), all = enc.encode(text), frames = rows.map(row => enc.encode(`data: ${JSON.stringify(row)}\n\n`));
    frames.push(enc.encode("data: [DONE]\n\n")); let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) {
      if (framing === "frames") { if (i < frames.length) c.enqueue(frames[i++]!); else c.close(); }
      else if (i < all.length) { const end = framing === "bytes" ? i + 1 : all.length; c.enqueue(all.slice(i, end)); i = end; }
      else c.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  });
  expect(result.http).toBe(1);
  expect(["undeclared_tool", "tool_identity_conflict"]).toContain(result.diagnostic?.normalizeCause ?? "not_observed");
  expect(result.events.some(e => e.type === "backend_finish")).toBe(false);
  const audit = result.diagnostic?.stream?.toolIdentity;
  expect(audit?.firstMismatch?.relation).toBe("strict_prefix");
  expect(audit?.tail.some(e => e.layer === "sdk" && e.wireNameMatched === false)).toBe(false);
});
