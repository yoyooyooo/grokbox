import { describe, expect, test } from "bun:test";
import { admitOverflowRecovery } from "@grokbox/runtime-kernel/inference";
import { emptyRecoveryLedger } from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown, isProviderConfirmedOverflow, overflowEvidenceFromProvider, structuredOverflowFromUnknown } from "../src/internal/backends/provider-error.ts";

delete process.env.GROKBOX_MODELD_HOST_COMPACT;
delete process.env.GROKBOX_CONTEXT_CAP;
delete process.env.GROKBOX_ALLOW_LIVE_HOST;

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
      providerCode: "context_length_exceeded", httpStatus: 400, releasedText: 1,
    })).toBe(true);
    expect(isProviderConfirmedOverflow({
      providerCode: "context_length_exceeded", releasedText: 0, releasedReasoning: 0, releasedTools: 0,
    })).toBe(false);
  });

  test("structured Responses 400 and response.failed codes confirm; message-only does not", () => {
    expect(structuredOverflowFromUnknown({
      statusCode: 400,
      data: { error: { code: "context_length_exceeded", type: "invalid_request_error" } },
    })).toEqual({ httpStatus: 400, providerCode: "context_length_exceeded" });
    expect(structuredOverflowFromUnknown({
      type: "response.failed",
      response: { error: { code: "context_too_large", message: "too big" } },
    })).toEqual({ httpStatus: 200, providerCode: "context_too_large" });
    expect(isProviderConfirmedOverflow(structuredOverflowFromUnknown({
      statusCode: 400,
      data: { error: { code: "context_length_exceeded" } },
    }))).toBe(true);
    expect(isProviderConfirmedOverflow(structuredOverflowFromUnknown({
      type: "response.failed",
      response: { error: { code: "context_length_exceeded" } },
    }))).toBe(true);
    expect(isProviderConfirmedOverflow({
      httpStatus: 200,
      providerCode: "context_length_exceeded",
    })).toBe(true);
    expect(structuredOverflowFromUnknown({ statusCode: 400, message: "context_length_exceeded in prose" })).toEqual({
      httpStatus: 400,
    });
    expect(isProviderConfirmedOverflow({ httpStatus: 400, providerCode: "context_window_exceeded" })).toBe(false);
  });

  test("structured auth/status conflicts veto overflow confirmation", () => {
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      data: { error: { type: "authentication_error", code: "context_length_exceeded" } },
    })).toBe(false);
    expect(overflowEvidenceFromProvider({
      statusCode: 400,
      data: { error: { type: "authentication_error", code: "context_length_exceeded" } },
    }).auth).toBe(true);
    expect(isProviderConfirmedOverflow({
      code: "invalid_api_key",
      data: { error: { code: "context_length_exceeded" } },
      statusCode: 400,
    })).toBe(false);
    expect(overflowEvidenceFromProvider({
      statusCode: 400,
      status: 429,
      data: { error: { code: "context_length_exceeded" } },
    }).unknown).toBe(true);
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      status: 429,
      data: { error: { code: "context_length_exceeded" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      type: "response.failed",
      statusCode: "401",
      response: { error: { code: "context_length_exceeded" } },
    })).toBe(false);
    expect(overflowEvidenceFromProvider({
      type: "response.failed",
      statusCode: "401",
      response: { error: { code: "context_length_exceeded" } },
    }).unknown).toBe(true);
  });

  test("message-only overflow is not confirmation", () => {
    expect(isProviderConfirmedOverflow({
      httpStatus: 400,
      providerCode: undefined,
    })).toBe(false);
    const evidence = overflowEvidenceFromProvider({ httpStatus: 400 });
    expect(JSON.stringify(evidence)).not.toContain("sk-");
    expect(evidence.providerCode).toBeUndefined();
    expect(evidence.releasedText).toBeUndefined();
  });

  test("synthetic Responses 400+code and response.failed+code confirm", () => {
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { type: "invalid_request_error", code: "context_length_exceeded", message: "too many tokens" },
      }),
    })).toBe(true);
    expect(isProviderConfirmedOverflow({
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "context_length_exceeded", message: "window full" },
      },
    })).toBe(true);
    expect(isProviderConfirmedOverflow({
      type: "error",
      error: { code: "context_too_large", type: "invalid_request_error" },
    })).toBe(true);
  });

  test("text compatibility recognizes explicit overflow phrases", () => {
    // Owned proxy-shaped error: this does not qualify a live provider.
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      data: { error: { type: "upstream_error", message: "This model's maximum context length was exceeded" } },
    })).toBe(true);
    expect(overflowEvidenceFromProvider({
      statusCode: 400,
      data: { error: { type: "upstream_error", message: "This model's maximum context length was exceeded" } },
    }).messageFallback).toBe(true);
    expect(structuredOverflowFromUnknown({
      statusCode: 400,
      data: { error: { type: "upstream_error", message: "This model's maximum context length was exceeded" } },
    }).providerCode).toBeUndefined();
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      data: { error: { type: "invalid_request_error", message: "bad json" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      type: "response.failed",
      response: { status: "failed", error: { message: "context length exceeded" } },
    })).toBe(true);
  });

  test("401/429/413/stream-truncate/max_tokens never classify as overflow", () => {
    expect(isProviderConfirmedOverflow({
      statusCode: 401,
      data: { error: { type: "authentication_error", message: "invalid api key" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      statusCode: 429,
      data: { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      statusCode: 413,
      data: { error: { type: "invalid_request_error", message: "Request payload is too large" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      statusCode: 502,
      data: { error: { code: "upstream_stream_truncated", message: "context length exceeded" } },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({
      type: "error",
      error: { code: "upstream_stream_read_error", message: "context window exceeded" },
    })).toBe(false);
    expect(isProviderConfirmedOverflow({ finishReason: "length" })).toBe(false);
    expect(isProviderConfirmedOverflow({ stop_reason: "max_tokens" })).toBe(false);
    expect(isProviderConfirmedOverflow({
      statusCode: 400,
      data: { error: { type: "invalid_request_error", message: "max_tokens is too large" } },
    })).toBe(false);
  });

  test("output-parameter errors mentioning context capacity do not authorize compact", () => {
    for (const message of [
      "The maximum context length is 8192; max_tokens must be at least 1",
      "max_tokens exceeds the maximum context length",
      "The context length is 8192; max_tokens is too large",
    ]) {
      const error = Object.assign(new Error(message), {
        statusCode: 400,
        data: { error: { type: "invalid_request_error", param: "max_tokens", message } },
      });
      expect(isProviderConfirmedOverflow(error), message).toBe(false);
      expect(backendFailureFromUnknown(error).code, message).toBe("provider_error");
    }
  });

  test("a token count containing 401 cannot override structured overflow evidence", () => {
    for (const count of [1400, 1401, 4010]) {
      const error = Object.assign(new Error(`context_length_exceeded: requested ${count} tokens`), {
        statusCode: 400, data: { error: { code: "context_length_exceeded" } },
      });
      const failure = backendFailureFromUnknown(error);
      expect(failure.code).toBe("overflow_candidate");
      expect(failure.overflowEvidence?.auth).toBe(false);
    }
  });

  test("omitted or invalid release counts do not admit recovery", () => {
    const tuple = { agentId: "a", turnId: "t", stepId: "s", bindingId: "b", selectionRevision: "r" };
    const base = {
      ledger: emptyRecoveryLedger(tuple, "n"),
      identity: tuple,
      recoveryNonce: "n",
    };
    expect(admitOverflowRecovery({
      ...base,
      evidence: overflowEvidenceFromProvider({ providerCode: "context_length_exceeded", httpStatus: 400 }),
    })).toBe("unconfirmed");
    expect(admitOverflowRecovery({
      ...base,
      evidence: overflowEvidenceFromProvider({
        providerCode: "context_length_exceeded", httpStatus: 400, releasedText: Number.NaN, releasedReasoning: 0, releasedTools: 0,
      }),
    })).toBe("unconfirmed");
    expect(admitOverflowRecovery({
      ...base,
      evidence: overflowEvidenceFromProvider({
        providerCode: "context_length_exceeded", httpStatus: 400, releasedText: 0, releasedReasoning: 0, releasedTools: 0,
      }),
    })).toBeUndefined();
    expect(admitOverflowRecovery({
      ...base,
      evidence: overflowEvidenceFromProvider({
        providerCode: "context_length_exceeded", releasedText: 0, releasedReasoning: 0, releasedTools: 0,
      }),
    })).toBe("unconfirmed");
    expect(admitOverflowRecovery({
      ...base,
      evidence: overflowEvidenceFromProvider({
        providerCode: "context_length_exceeded", httpStatus: 200, releasedText: 0, releasedReasoning: 0, releasedTools: 0,
      }),
    })).toBeUndefined();
  });
});
