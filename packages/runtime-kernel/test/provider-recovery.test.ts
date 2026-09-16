import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { BackendFailure, BindingFailure, annotateFailureSummary, providerRecoveryOf, projectProviderRecoveryPolicy, type InferenceEvent, type ProviderRecoveryPolicy, type ProviderRecoveryState } from "../src/contract.ts";
import { withProviderRecovery, type RecoveryProgress } from "../src/internal/inference/provider-recovery.ts";

const policy: ProviderRecoveryPolicy = { version: 1, mode: "pre-output-http", allowDuplicateInference: true, maxExtraRequests: 2, windowMs: 1000, baseDelayMs: 2, maxDelayMs: 20 };
const done: InferenceEvent = { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
function failure(status = 502, providerCode?: string) {
  return annotateFailureSummary(new BackendFailure("provider_error"), { version: 1, code: "provider_error", phase: "provider", reason: "http", http: { status }, providerCode });
}
async function run(options: {
  policy?: ProviderRecoveryPolicy; stream?: (ordinal: number) => Stream.Stream<InferenceEvent, unknown>;
  persist?: (s: ProviderRecoveryState, write: number) => Effect.Effect<void, BindingFailure>;
  beforeAttempt?: (ordinal: number) => Effect.Effect<void, unknown>;
  changed?: (s: ProviderRecoveryState) => Effect.Effect<void, unknown>;
} = {}) {
  const records: ProviderRecoveryState[] = [], progress: RecoveryProgress = {}, output: InferenceEvent[] = [], starts: Array<{ id: string; ordinal: number }> = [];
  let writes = 0;
  const stream = withProviderRecovery({ policy: options.policy ?? policy, identity: "service:step", snapshotDigest: "a".repeat(64), progress,
    beforeAttempt: options.beforeAttempt ?? (() => Effect.void),
    stream: (id, ordinal) => { starts.push({ id, ordinal }); return options.stream?.(ordinal) ?? (ordinal === 1 ? Stream.fail(failure()) : Stream.make({ type: "text_delta", text: "ok" } as InferenceEvent, done)); },
    persist: s => Effect.gen(function* () { if (options.persist) yield* options.persist(s, ++writes); records.push(structuredClone(s)); }),
    changed: options.changed,
  });
  const result = await Effect.runPromise(Effect.scoped(Effect.result(Stream.runForEach(stream, e => Effect.sync(() => { output.push(e); })))));
  return { result, output, records, progress: progress.current!, starts };
}

describe("single-owner provider recovery", () => {
  test("502 then success has durable distinct attempt identities and one released terminal", async () => {
    const out = await run();
    expect(out.result._tag).toBe("Success"); expect(out.starts.map(s => s.ordinal)).toEqual([1, 2]);
    expect(out.starts[0]!.id).not.toBe(out.starts[1]!.id);
    expect(out.records.some(s => s.phase === "waiting")).toBe(true);
    for (const s of out.starts) expect(out.records.some(r => r.attempts.some(a => a.id === s.id && a.state === "dispatch_reserved"))).toBe(true);
    expect(out.output.filter(e => e.type === "backend_finish")).toHaveLength(1);
    expect(out.progress).toMatchObject({ phase: "succeeded", stopReason: "success", outcomeUncertain: true, settlementRecorded: true });
    expect(out.progress.attempts.map(a => a.state)).toEqual(["failed", "completed"]);
  });
  for (const status of [400, 401, 403, 404, 500] as const) test(`HTTP ${status} is not retried by the transient policy`, async () => {
    const out = await run({ stream: () => Stream.fail(failure(status)) });
    expect(out.starts).toHaveLength(1); expect(out.result._tag).toBe("Failure"); expect(out.progress.stopReason).toBe("not_retryable");
  });
  test("429 quota is not a rate-limit retry", async () => {
    const out = await run({ stream: () => Stream.fail(failure(429, "insufficient_quota")) });
    expect(out.starts).toHaveLength(1); expect(out.progress.stopReason).toBe("not_retryable");
  });
  test("explicitly disabled policy makes one call", async () => {
    const out = await run({ policy: { ...policy, mode: "off", allowDuplicateInference: false, maxExtraRequests: 0 }, stream: () => Stream.fail(failure()) });
    expect(out.starts).toHaveLength(1); expect(out.progress.stopReason).toBe("disabled");
  });
  for (const part of [
    { type: "text_delta", text: "visible" }, { type: "reasoning_delta", text: "reasoning" },
    { type: "tool_start", toolCallId: "call", toolName: "lookup" },
  ] as InferenceEvent[]) test(`${part.type} prevents re-inference after any output material`, async () => {
    const out = await run({ stream: () => Stream.concat(Stream.make(part), Stream.fail(failure())) });
    expect(out.starts).toHaveLength(1); expect(out.progress.stopReason).toBe("output_observed");
  });
  test("empty text is not meaningful output and does not defeat a safe HTTP retry", async () => {
    const out = await run({ stream: n => n === 1 ? Stream.concat(Stream.make({ type: "text_delta", text: "" } as InferenceEvent), Stream.fail(failure())) : Stream.make(done) });
    expect(out.result._tag).toBe("Success"); expect(out.starts).toHaveLength(2);
  });
  test("a partial tool followed by EOF never receives a invented finish or retry", async () => {
    const out = await run({ stream: () => Stream.make({ type: "tool_start", toolCallId: "call", toolName: "lookup" } as InferenceEvent) });
    expect(out.result._tag).toBe("Failure"); expect(out.starts).toHaveLength(1);
    expect(out.output.some(e => e.type === "backend_finish")).toBe(false);
  });
  test("per-STEP request spend budget stops without becoming service lifetime capacity", async () => {
    const out = await run({ stream: () => Stream.fail(failure(503)) });
    expect(out.starts).toHaveLength(3); expect(out.progress.stopReason).toBe("attempt_budget");
  });
  test("claim storage failure prevents the first provider effect", async () => {
    const out = await run({ persist: () => Effect.fail(new BindingFailure("ledger_unavailable")) });
    expect(out.starts).toHaveLength(0); expect(out.progress.stopReason).toBe("storage_unavailable");
  });
  test("failed attempt settlement cannot authorize a retry", async () => {
    const out = await run({ persist: s => s.attempts.some(a => a.state === "failed") ? Effect.fail(new BindingFailure("ledger_unavailable")) : Effect.void });
    expect(out.starts).toHaveLength(1); expect(out.progress.settlementRecorded).toBe(false);
    expect(out.progress.stopReason).toBe("storage_unavailable");
  });
  test("successful terminal is held until its attempt settlement commits", async () => {
    const out = await run({ stream: () => Stream.make(done), persist: s => s.phase === "succeeded" ? Effect.fail(new BindingFailure("ledger_unavailable")) : Effect.void });
    expect(out.result._tag).toBe("Failure"); expect(out.output).toEqual([]); expect(out.starts).toHaveLength(1);
  });
  test("permission/configuration fence before retry prevents a second provider effect", async () => {
    const out = await run({ beforeAttempt: n => n > 1 ? Effect.fail(new BindingFailure("selection_mismatch")) : Effect.void });
    expect(out.starts).toHaveLength(1); expect(out.progress.stopReason).toBe("configuration_changed");
  });
  test("observability failure does not create a model attempt or change execution", async () => {
    const out = await run({ changed: () => Effect.fail(new Error("observer unavailable")) });
    expect(out.result._tag).toBe("Success"); expect(out.starts).toHaveLength(2);
  });
  test("cancelling a waiting STEP cancels its owned sleep and never starts another attempt", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>()), progress: RecoveryProgress = {};
    const records: ProviderRecoveryState[] = []; let starts = 0;
    const stream = withProviderRecovery({ policy: { ...policy, windowMs: 60_000, baseDelayMs: 30_000, maxDelayMs: 30_000 }, identity: "cancel", snapshotDigest: "a".repeat(64), progress,
      beforeAttempt: () => Effect.void, stream: () => { starts++; return Stream.fail(failure()); },
      persist: s => Effect.sync(() => { records.push(structuredClone(s)); }),
      changed: s => s.phase === "waiting" ? Deferred.succeed(entered, undefined).pipe(Effect.asVoid) : Effect.void });
    const fiber = Effect.runFork(Effect.scoped(Stream.runDrain(stream)));
    await Effect.runPromise(Deferred.await(entered)); await Effect.runPromise(Fiber.interrupt(fiber));
    expect(starts).toBe(1); expect(progress.current?.phase).toBe("cancelled"); expect(records.at(-1)?.stopReason).toBe("cancelled");
  });
  test("retry deadline is rechecked after a slow authority fence", async () => {
    let starts = 0; const progress: RecoveryProgress = {}, fence = await Effect.runPromise(Deferred.make<void>());
    const program = Effect.scoped(Effect.gen(function* () {
      const stream = withProviderRecovery({ policy: { ...policy, windowMs: 100, baseDelayMs: 1, maxDelayMs: 1 }, identity: "deadline", snapshotDigest: "a".repeat(64), progress,
        persist: () => Effect.void,
        stream: () => { starts++; return Stream.fail(failure()); },
        beforeAttempt: ordinal => ordinal === 1 ? Effect.void : Deferred.succeed(fence, undefined).pipe(Effect.andThen(Effect.sleep("200 millis"))) });
      const fiber = yield* Effect.forkChild(Effect.result(Stream.runDrain(stream)));
      yield* TestClock.adjust("10 millis"); yield* Deferred.await(fence); yield* TestClock.adjust("201 millis");
      return yield* Fiber.join(fiber);
    })).pipe(Effect.provide(TestClock.layer()));
    const result = await Effect.runPromise(program);
    expect(result._tag).toBe("Failure"); expect(starts).toBe(1); expect(progress.current?.stopReason).toBe("deadline");
  }, 3000);
});
