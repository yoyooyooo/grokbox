import { nativeHostQualificationEnabled, QUALIFIED_NATIVE_HOST_SHA } from "./native-host-qualification.ts";
import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { hostVisibleStreamError, InvalidHostStateError, isHostManagedFailure } from "../src/internal/host/session.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { NATIVE_HOST_BUNDLE as LIVE_HOST_BUNDLE } from "./native-host-source.ts";
import { HOST_MANAGED_FAILURE_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";

// Owned policy fixture. Deliberately permissive: the outer automation route must
// not turn a managed terminal into a new TURN, bypassing the inner provider gate.
const SOURCE = `
function shouldRetryTurnAttempt(input) {
  if (input.canceled) return false;
  if (input.automationIsRetryable) return input.automationIsRetryable(input.error);
  return input.providerRetryable && (!input.streamOutputProduced || input.resumeCheckpointAvailable);
}
function computeBackoffDelayMs(params) { return params.delay; }
module.exports = shouldRetryTurnAttempt;
`;
type Input = {
  error: unknown; canceled: boolean; streamOutputProduced: boolean;
  resumeCheckpointAvailable: boolean; providerRetryable: boolean;
  automationIsRetryable?: (error: unknown) => boolean;
};
function load(enabled: boolean) {
  const patches = LIVE_SLICE_PATCHES.filter((p) => p.id === "managed-turn-retry-gate");
  const applied = patches.length === 0 ? { ok: true as const, source: SOURCE } : transformUnchecked(SOURCE, patches);
  if (!applied.ok) throw new Error("owned_turn_retry_fixture_invalid");
  const module = { exports: undefined as unknown as (input: Input) => boolean };
  runInContext(applied.source, createContext({ module, Symbol, globalThis: enabled
    ? { [Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)]: isHostManagedFailure } : {} }));
  return module.exports;
}

test("managed terminal blocks outer automation retry before a new TURN or checkpoint replay", () => {
  const retry = load(true);
  const managed = hostVisibleStreamError({ code: "model_error", userVisible: true, message: "owned failure" });
  let automationCalls = 0;
  for (const error of [managed, new Error("native wrapper", { cause: managed }), new InvalidHostStateError()]) {
    for (const produced of [false, true]) {
      const input = { error, canceled: false, streamOutputProduced: produced, resumeCheckpointAvailable: true,
        providerRetryable: true, automationIsRetryable: () => { automationCalls++; return true; } };
      let turns = 0;
      do { turns++; } while (turns < 4 && retry(input));
      expect(turns).toBe(1);
    }
  }
  expect(automationCalls).toBe(0);
});

test.skipIf(!nativeHostQualificationEnabled())("exact native outer retry loop keeps managed terminal at one attempt and official retries intact", async () => {
  const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(QUALIFIED_NATIVE_HOST_SHA);
  const wanted = [["shouldRetryTurnAttempt", "function"], ["runWithTransientRetry", "async function"]] as const;
  const selected = new Map<string, string>();
  // These two pinned declarations own the retry experiment; unrelated Host
  // declarations do not need a retained AST in the execution shard.
  for (const [name, kind] of wanted) {
    const marker = `\n${kind} ${name}(`, start = source.indexOf(marker);
    const end = source.indexOf("\n}", start + marker.length);
    if (start < 0 || source.indexOf(marker, start + marker.length) !== -1 || end < 0 || end - start > 64 * 1024)
      throw Error("native_retry_declaration_layout");
    const parsed = ts.createSourceFile("qualified-host.cjs", source.slice(start + 1, end + 2), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = parsed.statements[0];
    if ((parsed as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length
      || parsed.statements.length !== 1 || !declaration || !ts.isFunctionDeclaration(declaration) || declaration.name?.text !== name)
      throw Error("native_retry_declaration_shape");
    expect(selected.has(name)).toBe(false);
    selected.set(name, declaration.getText(parsed));
  }
  expect(selected.size).toBe(2);
  const frame = `${selected.get("shouldRetryTurnAttempt")}\nfunction computeBackoffDelayMs(params) { return 0; }\n${selected.get("runWithTransientRetry")}\nmodule.exports = { shouldRetryTurnAttempt, runWithTransientRetry };`;
  const patches = LIVE_SLICE_PATCHES.filter((p) => p.id === "managed-turn-retry-gate");
  const applied = transformUnchecked(frame, patches);
  if (!applied.ok) throw new Error("native_retry_patch_failed");
  const module = { exports: undefined as unknown as {
    shouldRetryTurnAttempt(input: Input): boolean;
    runWithTransientRetry(run: () => Promise<never>, policy: Record<string, unknown>): Promise<never>;
  } };
  runInContext(applied.source, createContext({ module, Symbol,
    isRetryableProviderError: () => false, isFirstTokenStallError: () => false, isStreamIdleError: () => false,
    isTransientStreamError: () => true, serverRetryAfterMsFromError: () => undefined,
    globalThis: { [Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)]: isHostManagedFailure },
  }));
  const managed = hostVisibleStreamError({ code: "model_error", userVisible: true, message: "owned" });
  for (const [error, expected] of [[managed, 1], [new Error("wrap", { cause: managed }), 1], [new Error("official"), 4]] as const) {
    let calls = 0;
    let sleeps = 0;
    await expect(module.exports.runWithTransientRetry(async () => { calls++; throw error; }, {
      maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => { sleeps++; },
      isRetryable: (error: unknown) => module.exports.shouldRetryTurnAttempt({
        error, canceled: false, providerRetryable: false, streamOutputProduced: false,
        resumeCheckpointAvailable: true, automationIsRetryable: () => true,
      }),
    })).rejects.toBe(error);
    expect(calls).toBe(expected);
    expect(sleeps).toBe(expected - 1);
  }
});

test("official retry, cancellation, and missing-hook behavior are unchanged", () => {
  const on = load(true);
  const off = load(false);
  const official = new Error("official outage");
  const forged = Object.assign(new Error("provider controlled"), { name: "RetriableError", code: "model_error" });
  for (const error of [official, forged]) {
    expect(on({ error, canceled: false, streamOutputProduced: false, resumeCheckpointAvailable: false, providerRetryable: true })).toBe(true);
    expect(on({ error, canceled: true, streamOutputProduced: false, resumeCheckpointAvailable: true, providerRetryable: true })).toBe(false);
    expect(on({ error, canceled: false, streamOutputProduced: true, resumeCheckpointAvailable: false, providerRetryable: true })).toBe(false);
  }
  const managed = hostVisibleStreamError({ code: "model_error", userVisible: true, message: "owned failure" });
  expect(off({ error: managed, canceled: false, streamOutputProduced: false, resumeCheckpointAvailable: false, providerRetryable: true })).toBe(true);
});
