import { describe, expect, test } from "bun:test";
import { isConfirmedOverflow } from "@grokbox/runtime-kernel/contract";
import { isProviderConfirmedOverflow, overflowEvidenceFromProvider } from "../src/internal/backends/provider-error.ts";

describe("confirmed overflow classifier", () => {
  test("structured overflow codes confirm; auth/429/413/unknown do not", () => {
    expect(isProviderConfirmedOverflow({ providerCode: "context_length_exceeded", httpStatus: 400 })).toBe(true);
    expect(isProviderConfirmedOverflow({ providerCode: "context_too_large", httpStatus: 200 })).toBe(true);
    expect(isProviderConfirmedOverflow({
      providerCode: "context_length_exceeded", httpStatus: 400, auth: true,
    })).toBe(false);
    expect(isProviderConfirmedOverflow({ providerCode: "context_length_exceeded", httpStatus: 401 })).toBe(false);
    expect(isProviderConfirmedOverflow({ providerCode: "context_length_exceeded", httpStatus: 429 })).toBe(false);
    expect(isProviderConfirmedOverflow({ httpStatus: 413, providerCode: "request_too_large" })).toBe(false);
    expect(isProviderConfirmedOverflow({ httpStatus: 400, providerCode: "invalid_request_error" })).toBe(false);
    expect(isProviderConfirmedOverflow({ httpStatus: 400 })).toBe(false);
    expect(isProviderConfirmedOverflow({
      providerCode: "context_length_exceeded", releasedText: 1,
    })).toBe(true);
    expect(isConfirmedOverflow(overflowEvidenceFromProvider({
      providerCode: "context_length_exceeded", releasedText: 1,
    }))).toBe(true);
  });

  test("message-only overflow is not confirmation", () => {
    expect(isProviderConfirmedOverflow({
      httpStatus: 400,
      providerCode: undefined,
    })).toBe(false);
    const evidence = overflowEvidenceFromProvider({ httpStatus: 400 });
    expect(JSON.stringify(evidence)).not.toContain("sk-");
    expect(evidence.providerCode).toBeUndefined();
  });
});
