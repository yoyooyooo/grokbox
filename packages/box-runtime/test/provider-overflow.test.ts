import { describe, expect, test } from "bun:test";
import { inspectProviderError } from "../src/provider-overflow.ts";

describe("provider overflow classification (log-only)", () => {
  test("overflow-shaped OpenAI/CCS errors are candidates", () => {
    const coded = inspectProviderError({
      statusCode: 400,
      data: { error: { message: "This model's maximum context length is 128000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } },
    });
    expect(coded.overflowCandidate).toBe(true);
    expect(coded.overflowReasons).toContain("provider_code");
    expect(coded.providerCode).toBe("context_length_exceeded");
    expect(coded.status).toBe(400);

    const messaged = inspectProviderError({
      status: 400,
      message: "prompt is too long for this model",
    });
    expect(messaged.overflowCandidate).toBe(true);
    expect(messaged.overflowReasons).toContain("status_message");
  });

  test("auth, rate-limit, generic 400, and 500 are not overflow", () => {
    expect(inspectProviderError({ statusCode: 401, data: { error: { code: "invalid_api_key", message: "Incorrect API key" } } }).overflowCandidate).toBe(false);
    expect(inspectProviderError({ statusCode: 429, data: { error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } } }).overflowCandidate).toBe(false);
    expect(inspectProviderError({ statusCode: 400, data: { error: { code: "invalid_request", message: "invalid json" } } }).overflowCandidate).toBe(false);
    expect(inspectProviderError({ statusCode: 500, message: "internal" }).overflowCandidate).toBe(false);
    expect(inspectProviderError(new Error("network down")).overflowCandidate).toBe(false);
  });

  test("does not persist body snippets or unknown provider tokens", () => {
    const evidence = inspectProviderError({
      statusCode: 401,
      data: { error: { code: "invalid_api_key", type: "invalid_request_error", message: "Bearer syncred_opaque_7c91 failed with sk-abc123" } },
    });
    expect(evidence).not.toHaveProperty("bodySnippet");
    expect(evidence.providerCode).toBe("unknown");
    expect(evidence.providerType).toBe("unknown");
    expect(JSON.stringify(evidence)).not.toMatch(/syncred_opaque_7c91|sk-abc123/);
    expect(evidence.overflowCandidate).toBe(false);
  });
});
