import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Latch, Layer, Stream } from "effect";
import {
  CompactFailure,
  contextSnapshotBody,
  emptyRecoveryLedger,
  type OverflowEvidence,
  type RecoveryTuple,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { BackendFailure, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { admitOverflowRecovery, inferenceMemoryLayer, runOverflowRecovery, runStep } from "@grokbox/runtime-kernel/inference";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeHostCompactLayer,
  fakeModelBackendLayer,
} from "@grokbox/runtime-kernel/testing";

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
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    })));
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe("capability_not_ready");
    expect(ledger.nonceConsumed).toBe(false);
    expect(ledger.compactInvocations).toBe(0);
  });

  test("unavailable compact does not resume", async () => {
    const counts = { invocations: 0 };
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({ counts })))));
    expect(counts.invocations).toBe(1);
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe("capability_not_ready");
    expect(ledger.nonceConsumed).toBe(true);
    expect(ledger.compactInvocations).toBe(1);
    await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({ counts })))));
    expect(counts.invocations).toBe(1);
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
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ releasedText: undefined }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ releasedText: Number.NaN }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({ ...base, evidence: evidence({ releasedTools: -1 }) })).toBe("unconfirmed");
    expect(admitOverflowRecovery({
      ...base,
      evidence: evidence({ httpStatus: undefined, releasedText: 0, releasedReasoning: 0, releasedTools: 0 }),
    })).toBe("unconfirmed");
  });

  test("absent HTTP surface with known-zero releases does not consume a slot", async () => {
    const counts = { invocations: 0 };
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger,
      evidence: evidence({ httpStatus: undefined }),
      identity: TUPLE,
      recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({
      counts,
      handle: () => ({ kind: "snapshot", snapshot: snapshot("compacted") }),
    })))));
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe("unconfirmed");
    expect(counts.invocations).toBe(0);
    expect(ledger.nonceConsumed).toBe(false);
    expect(ledger.compactInvocations).toBe(0);
  });

  test("cancelled and unknown compact outcomes stop without resume", async () => {
    for (const reason of ["cancelled", "unknown", "blocked"] as const) {
      const counts = { invocations: 0 };
      const ledger = emptyRecoveryLedger(TUPLE, NONCE);
      const result = await Effect.runPromise(Effect.result(runOverflowRecovery({
        ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
      }).pipe(Effect.provide(fakeHostCompactLayer({
        counts,
        handle: () => ({ kind: "unavailable", reason }),
      })))));
      expect(counts.invocations).toBe(1);
      expect(result._tag === "Failure" ? (result.failure as CompactFailure).code : undefined).toBe(reason);
      expect(ledger.nonceConsumed).toBe(true);
      await Effect.runPromise(Effect.result(runOverflowRecovery({
        ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
      }).pipe(Effect.provide(fakeHostCompactLayer({ counts })))));
      expect(counts.invocations).toBe(1);
    }
  });

  test("concurrent duplicates share one reserved compact slot", async () => {
    const counts = { invocations: 0 };
    const hold = await Effect.runPromise(Latch.make(false));
    const seen = await Effect.runPromise(Deferred.make<void>());
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const layer = fakeHostCompactLayer({
      counts,
      before: Effect.gen(function* () {
        yield* Deferred.succeed(seen, undefined).pipe(Effect.ignore);
        yield* hold.await;
      }),
      handle: () => ({ kind: "snapshot", snapshot: snapshot("compacted") }),
    });
    const run = runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(layer), Effect.result);
    const first = Effect.runFork(run);
    const second = Effect.runFork(run);
    await Effect.runPromise(Deferred.await(seen));
    expect(counts.invocations).toBe(1);
    await Effect.runPromise(hold.open);
    const [a, b] = [await Effect.runPromise(Fiber.join(first)), await Effect.runPromise(Fiber.join(second))];
    const tags = [a._tag, b._tag].sort();
    expect(tags).toEqual(["Failure", "Success"]);
    expect(counts.invocations).toBe(1);
    expect(ledger.compactInvocations).toBe(1);
    expect(ledger.nonceConsumed).toBe(true);
  });

  test("interruption keeps the reserved slot", async () => {
    const counts = { invocations: 0 };
    const hold = await Effect.runPromise(Latch.make(false));
    const seen = await Effect.runPromise(Deferred.make<void>());
    const ledger = emptyRecoveryLedger(TUPLE, NONCE);
    const layer = fakeHostCompactLayer({
      counts,
      before: Effect.gen(function* () {
        yield* Deferred.succeed(seen, undefined);
        yield* hold.await;
      }),
      handle: () => ({ kind: "snapshot", snapshot: snapshot("compacted") }),
    });
    const fiber = Effect.runFork(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(layer)));
    await Effect.runPromise(Deferred.await(seen));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(ledger.nonceConsumed).toBe(true);
    expect(ledger.compactInvocations).toBe(1);
    await Effect.runPromise(Effect.result(runOverflowRecovery({
      ledger, evidence: evidence(), identity: TUPLE, recoveryNonce: NONCE,
    }).pipe(Effect.provide(fakeHostCompactLayer({ counts })))));
    expect(counts.invocations).toBe(1);
  });
});

describe("runStep overflow recovery is default-off without HostCompact", () => {
  const EVENTS: InferenceEvent[] = [
    { type: "text_delta", text: "ok" },
    { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
  ];
  const overflow = new BackendFailure("overflow_candidate", {
    overflowCandidate: true,
    overflowEvidence: { providerCode: "context_length_exceeded", httpStatus: 400 },
  });

  function file() {
    return parseModelsFile({
      version: 1,
      models: {
        [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" },
        "openai/gpt": {
          provider: "openai", model: "gpt", endpoint: "https://api.example.test/v1", apiKeyRef: "env:KEY",
          capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text", "tools"],
          contextWindowTokens: 200000,
        },
      },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    });
  }

  function req() {
    const captured = captureManagedSelection(file(), "agent-a");
    if (captured.kind !== "managed") throw new Error("expected managed");
    return {
      hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
      serviceEpoch: { incarnationId: "svc-1" },
      agentId: "agent-a",
      turnId: "turn-1",
      stepId: "step-1",
      selection: { agentId: "agent-a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
      snapshot: snapshot("hi"),
    };
  }

  test("without HostCompact the original overflow fails and compact is not invoked", async () => {
    const counts = createCountedSeams();
    const compactCounts = { invocations: 0 };
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1" })),
    );
    const result = await Effect.runPromise(Effect.gen(function* () {
      const admitted = yield* runStep(req());
      if (!("stream" in admitted)) return yield* Effect.fail(new Error("expected live"));
      return yield* Effect.result(Stream.runCollect(admitted.stream));
    }).pipe(Effect.provide(layer), Effect.scoped));
    expect(result._tag).toBe("Failure");
    expect(compactCounts.invocations).toBe(0);
    expect(counts.network).toBe(1);
  });

  test("with HostCompact a confirmed zero-release overflow compact-resumes once", async () => {
    const counts = createCountedSeams();
    const compactCounts = { invocations: 0 };
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1" })),
      Layer.merge(fakeHostCompactLayer({
        counts: compactCounts,
        handle: () => ({ kind: "snapshot", snapshot: snapshot("compacted") }),
      })),
    );
    const events = await Effect.runPromise(Effect.gen(function* () {
      const admitted = yield* runStep(req());
      if (!("stream" in admitted)) return yield* Effect.fail(new Error("expected live"));
      return yield* Stream.runCollect(admitted.stream);
    }).pipe(Effect.provide(layer), Effect.scoped));
    expect(compactCounts.invocations).toBe(1);
    expect(counts.network).toBe(2);
    expect([...events].some((event) => event.type === "text_delta")).toBe(true);
  });
});
