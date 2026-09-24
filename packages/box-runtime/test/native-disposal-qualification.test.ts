import { expect, test } from "bun:test";
import { readNativeSource } from "./native-host-source.ts";
import { runInNewContext } from "node:vm";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { CONT_NATIVE_PAIR, nativeContinuityEnabled } from "./native-continuity-code.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
const identities = [
  ["__addDisposableResource22", "\nvar __disposeResources22 =", "6b765884eb79ed9a26a3d4a190fddb0592faa7028ea5ff7c90422f9b2157c532"],
  ["__disposeResources22", "\nvar logger65 =", "072532d1842c670a1e86533f8ec1d3a6470e3311641771bc0cefd1f9ed6ea93c"],
] as const;
function originalHelpers() {
  const source = readNativeSource("source").toString("utf8");
  expect(sha256Text(source)).toBe(CONT_NATIVE_PAIR.host);
  const values = identities.map(([name, end, digest]) => {
    const start = `var ${name} = `, at = source.indexOf(start), to = source.indexOf(end, at);
    if (at < 0 || to < at || source.indexOf(start, at + start.length) >= 0 || to - at > 8192) throw Error("disposal_layout_unqualified");
    const expression = source.slice(at + start.length, to).trim().replace(/;$/, "");
    expect(sha256Text(expression)).toBe(digest);
    return runInNewContext(`(${expression})`, { Symbol, Error, TypeError, Promise }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  });
  return { add: values[0], dispose: values[1] };
}
nativeTest("compact lease uses the original runStep resource owner and finalizer", () => {
  const source = readNativeSource("source").toString("utf8");
  expect(sha256Text(source)).toBe(CONT_NATIVE_PAIR.host);
  const marker = "  async runStep(";
  const start = source.indexOf(marker), end = source.indexOf("\n  }", start);
  expect(start).toBeGreaterThan(-1);
  expect(source.indexOf(marker, start + marker.length)).toBe(-1);
  expect(end).toBeGreaterThan(start);
  expect(end - start).toBeLessThan(256 * 1024);
  const step = source.slice(start, end);
  const add = step.match(/(__addDisposableResource\d+)\(env_2,/g);
  const dispose = step.match(/(__disposeResources\d+)\(env_2\)/g);
  expect(add).toEqual([`${identities[0][0]}(env_2,`]);
  expect(dispose).toEqual([`${identities[1][0]}(env_2)`]);
  const registration = LIVE_SLICE_PATCHES.find(slice => slice.id === "compact-register")!;
  expect(registration.replacement.includes(`${identities[0][0]}(env_2, __grokbox_compact_slot, false)`)).toBe(true);
});
nativeTest("original synchronous disposal ABI preserves receiver, LIFO order and original return/throw", () => {
  const { add, dispose } = originalHelpers(), events: string[] = [], failure = {};
  for (const throws of [false, true]) {
    const env = { stack: [], error: undefined, hasError: false }, outer = { [Symbol.dispose]() { expect(this).toBe(outer); events.push("outer"); } }, lease = { [Symbol.dispose]() { expect(this).toBe(lease); events.push("lease"); } };
    expect(add(env, outer, false)).toBe(outer); expect(add(env, lease, false)).toBe(lease);
    if (throws) { Object.assign(env, { error: failure, hasError: true }); expect(() => dispose(env)).toThrow(); }
    else expect(dispose(env)).toBeUndefined();
    expect(env.stack).toHaveLength(0); expect(events.splice(0)).toEqual(["lease", "outer"]);
    if (throws) { try { dispose(env); } catch (error) { expect(error).toBe(failure); } }
  }
});
nativeTest("original helper continues closing outer resources when a lease disposer throws and retains both failures", () => {
  const { add, dispose } = originalHelpers(), primary = { source: "body" }, cleanup = { source: "cleanup" }, events: string[] = [];
  const env = { stack: [], error: primary, hasError: true };
  add(env, { [Symbol.dispose]() { events.push("outer"); } }, false);
  add(env, { [Symbol.dispose]() { events.push("lease"); throw cleanup; } }, false);
  let error: any; try { dispose(env); } catch (value) { error = value; }
  expect(events).toEqual(["lease", "outer"]); expect(env.stack).toHaveLength(0);
  expect(error.name).toBe("SuppressedError"); expect(error.error).toBe(cleanup); expect(error.suppressed).toBe(primary);
});
nativeTest("original helper rejects missing and asynchronous-only synchronous disposers before stack registration", () => {
  const { add } = originalHelpers(), env = { stack: [], error: undefined, hasError: false };
  for (const value of [{}, { [Symbol.asyncDispose]: async () => {} }, { [Symbol.dispose]: 1 }]) {
    expect(() => add(env, value, false)).toThrow(); expect(env.stack).toHaveLength(0);
  }
});
