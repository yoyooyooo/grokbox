import { describe, expect, test } from "bun:test";
import { admitOverflowRecovery } from "@grokbox/runtime-kernel/inference";
import { emptyRecoveryLedger } from "@grokbox/runtime-kernel/contract";
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
      providerCode: "context_length_exceeded", httpStatus: 400, releasedText: 1,
    })).toBe(true);
    expect(isProviderConfirmedOverflow({
      providerCode: "context_length_exceeded", releasedText: 0, releasedReasoning: 0, releasedTools: 0,
    })).toBe(false);
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
