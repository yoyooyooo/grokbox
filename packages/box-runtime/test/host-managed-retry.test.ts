import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { hostVisibleStreamError, InvalidHostStateError, isHostManagedFailure } from "../src/internal/host/session.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { HOST_MANAGED_FAILURE_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";

const SOURCE = `
class RetriableError extends Error {}
class NonRetriableError extends Error {}
class ActionRequiredError extends Error {}
function classifyError2(error42) { return new RetriableError("native generic classification"); }
function mayRetry(error42) {
  if (!(classifyError2(error42) instanceof RetriableError)) return false;
  return true;
}
function displayFailure(error42) {
  const classified = classifyError2(error42);
  if (classified instanceof NonRetriableError || classified instanceof ActionRequiredError) {
    return false;
  }
  return true;
}
module.exports = mayRetry;
`;

function retry(hook: boolean) {
  const transformed = transformUnchecked(SOURCE, LIVE_SLICE_PATCHES.filter((p) => p.id === "managed-retry-gate"));
  expect(transformed.ok).toBe(true);
  if (!transformed.ok) throw new Error("fixture transform");
  const module = { exports: undefined as unknown as (error: unknown) => boolean };
  const globals = hook ? { [Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)]: isHostManagedFailure } : {};
  runInContext(transformed.source, createContext({ module, Symbol, globalThis: globals }));
  return module.exports;
}

test("only real managed failures suppress native retry, including native cause wrapping", () => {
  const on = retry(true);
  const off = retry(false);
  const managed = hostVisibleStreamError({ userVisible: true, code: "model_error", message: "bounded" });
  const invalid = new InvalidHostStateError("unsupported_content");
  for (const error of [managed, invalid, new Error("wrapped", { cause: managed })]) {
    expect(isHostManagedFailure(error)).toBe(true);
    expect(on(error)).toBe(false);
    expect(off(error)).toBe(true);
  }
  const forged = Object.assign(new Error("same bounded message"), { name: "RetriableError", code: "model_error", userVisible: true });
  expect(isHostManagedFailure(forged)).toBe(false);
  expect(on(forged)).toBe(true);
  expect(on(new Error("official"))).toBe(true);
});

test("cause provenance does not run accessors or follow unbounded cycles", () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, "cause", { get() { getters++; return new InvalidHostStateError(); } });
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isHostManagedFailure(accessor)).toBe(false);
  expect(isHostManagedFailure(cycle)).toBe(false);
  expect(getters).toBe(0);
});
