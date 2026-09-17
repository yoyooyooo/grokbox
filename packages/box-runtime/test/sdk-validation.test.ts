import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { projectSdkValidation, streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown } from "../src/internal/backends/provider-error.ts";
import { sdkValidationObservation } from "../src/internal/backends/sdk-validation.ts";

const toolFrame = (type: string, first: boolean) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: first ? "fixture-call" : "", type, function: { name: first ? "Read" : "", arguments: first ? "" : "{}" } }] }, finish_reason: "" }] });
test("pinned SDK rejects an empty continuation type with a payload-free path", async () => {
  const frames = [toolFrame("function", true), toolFrame("", false)];
  const fakeFetch = Object.assign(async () => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }), { preconnect: async () => undefined });
  const model = createOpenAI({ apiKey: "synthetic-only", fetch: fakeFetch }).chat("fixture");
  const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] });
  let observed: unknown;
  for await (const part of result.stream) if (part.type === "error") observed = part.error;
  const witness = sdkValidationObservation(observed);
  expect(witness?.kind).toBe("schema");
  expect(witness?.issues).toContainEqual({ path: ["choices", 0, "delta", "tool_calls", 0, "type"], code: "invalid_value", received: "empty_string" });
  const failure = backendFailureFromUnknown(observed);
  expect(failure.code).toBe("stream_invalid");
  expect(streamFailureDiagnostic(failure)).toMatchObject({ normalizeCause: "sdk_schema_mismatch", rejectSite: "sdk_part", sdkValidation: witness });
  expect(JSON.stringify(witness)).not.toContain("fixture-call");
  expect(projectSdkValidation(witness)).toEqual(witness);
});
test("validation projector rejects arbitrary paths and never reads accessor values", () => {
  let invoked = 0;
  const value = { kind: "schema", issues: [{ path: ["private-field"], code: "invalid_type", received: "string" },
    { path: ["choices", 0], get code() { invoked++; throw Error("secret"); }, received: "string" }], message: "secret" };
  expect(projectSdkValidation(value)).toEqual({ kind: "schema", issues: [] });
  expect(invoked).toBe(0);
  expect(sdkValidationObservation({ name: "AI_TypeValidationError", get cause() { invoked++; throw Error("secret"); } })).toEqual({ kind: "schema", issues: [] });
  expect(invoked).toBe(0);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("private trap"); } });
  expect(sdkValidationObservation(proxy)).toBeUndefined();
});
