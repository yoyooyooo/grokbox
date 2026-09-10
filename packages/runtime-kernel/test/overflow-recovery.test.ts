import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CompactFailure,
  contextSnapshotBody,
  emptyRecoveryLedger,
  type OverflowEvidence,
  type RecoveryTuple,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { admitOverflowRecovery, runOverflowRecovery } from "@grokbox/runtime-kernel/inference";
import { fakeHostCompactLayer } from "@grokbox/runtime-kernel/testing";

const TUPLE: RecoveryTuple = {
  agentId: "agent-a",
  turnId: "turn-1",
  stepId: "step-1",
  bindingId: "bind-1",
  selectionRevision: "rev-a",
};
const NONCE = "n".repeat(32);

function snapshot(text: string) {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }],
    messages: [{ role: "user", content: text }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function evidence(extra: Partial<OverflowEvidence> = {}): OverflowEvidence {
  return {
    providerCode: "context_length_exceeded",
    httpStatus: 400,
    releasedText: 0,
    releasedReasoning: 0,
    releasedTools: 0,
    ...extra,
  };
}

describe("overflow recovery ledger", () => {
  test("confirmed overflow with zero released content admits one compact and two managed attempts", async () => {
    const counts = { invocations: 0 };
    const next = snapshot("compacted");
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const result = await Effect.runPromise(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({
      counts,
      handle: () => ({ kind: "snapshot", snapshot: next }),
    }))));
    expect(counts.invocations).toBe(1);
    expect(result.ledger.compactInvocations).toBe(1);
    expect(result.ledger.managedAttempts).toBe(2);
    expect(result.ledger.nonceConsumed).toBe(true);
    expect(result.snapshot.messages).toEqual([{ role: "user", content: "compacted" }]);
    expect(admitOverflowRecovery({
      ledger: result.ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    })).toBe("nonce");
    expect(admitOverflowRecovery({
      ledger: { ...emptyRecoveryLedger(TUPLE, NONCE), managedAttempts: 2 },
      evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    })).toBe("exhausted");
  });

  test("missing HostCompact is capability_not_ready with zero invocations", async () => {
    const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger: emptyRecoveryLedger(TUPLE, NONCE),
      evidence: evidence(),
      identity: TUPLE,
      recoveryNonce: NONCE,
    })));
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure : undefined).toBeInstanceOf(CompactFailure);
    expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe("capability_not_ready");
  });

  test("unavailable compact does not resume", async () => {
    const counts = { invocations: 0 };
    const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger: emptyRecoveryLedger(TUPLE, NONCE),
      evidence: evidence(),
      identity: TUPLE,
      recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({ counts })))));
    expect(counts.invocations).toBe(1);
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe("capability_not_ready");
  });

  test("identity and nonce fences refuse extra dispatch", async () => {
    expect(admitOverflowRecovery({
      ledger: emptyRecoveryLedger(TUPLE, NONCE),
      evidence: evidence(),
      identity: { ...TUPLE, stepId: "other" },
      recoveryNonce: NONCE,
    })).toBe("identity");
    expect(admitOverflowRecovery({
      ledger: emptyRecoveryLedger(TUPLE, NONCE),
      evidence: evidence(),
      identity: TUPLE,
      recoveryNonce: "wrong",
    })).toBe("nonce");
  });

  test("unconfirmed errors and released content never compact", () => {
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const base = { ledger, identity: TUPLE, recoveryNonce: NONCE };
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ auth: true }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ httpStatus: 401 }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ httpStatus: 429 }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ httpStatus: 413 }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ providerCode: undefined }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ unknown: true }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ releasedText: 1 }) })).toBe("released");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ releasedTools: 1 }) })).toBe("released");
  });

  test("cancelled and unknown compact outcomes stop without resume", async () => {
    for (const reason of ["cancelled", "unknown", "blocked"] as const) {
      const counts = { invocations: 0 };
      const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
        ledger: emptyRecoveryLedger(TUPLE, NONCE),
        evidence: evidence(),
        identity: TUPLE,
        recoveryNonce: NONCE,
      }).pipe(Effect.provide(fakeHostCompactLayer({
        counts,
        handle: () => ({ kind: "unavailable", reason }),
      })))));
      expect(counts.invocations).toBe(1);
      expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe(reason);
    }
  });
});
