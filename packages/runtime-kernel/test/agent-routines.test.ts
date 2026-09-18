import { expect, test } from "bun:test";
import { Effect } from "effect";
import { AgentRoutines } from "../src/ports.ts";
import { runAgentRoutines } from "../src/commands.ts";
import { RoutineError, projectNativeRoutines, projectRoutineResult, type RoutineCommand } from "../src/routines.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = () => ({ id: "notify-runtime", name: "Runtime notices", prompt: "PRIVATE_BODY", trigger: { type: "webhook" },
  isEnabled: false, createdAt: 1000, lastRunAt: null, nextRunAt: null, filePath: "/PRIVATE/PATH", webhookUrl: "https://private.invalid/endpoint", key: "PRIVATE_KEY" });
function fixture(options: { lostResponse?: boolean; changedDefinition?: boolean; generationChanged?: boolean; postReadFails?: boolean } = {}) {
  let rows: unknown[] = [base(), { ...base(), id: "other-task", name: "Other" }], writes = 0, reads = 0;
  const snapshot = () => ({ catalog: projectNativeRoutines(AGENT, rows), generation: options.generationChanged && writes ? "new" : "old" });
  const run = (command: RoutineCommand) => Effect.runPromise(Effect.result(runAgentRoutines(command).pipe(Effect.provideService(AgentRoutines, {
    list: () => { reads++; return options.postReadFails && writes ? Effect.fail(new RoutineError("read_unavailable")) : Effect.sync(snapshot); },
    change: (_id, rid, action) => {
      writes++;
      rows = action === "delete" ? rows.filter(r => (r as { id: string }).id !== rid)
        : rows.map(r => (r as { id: string }).id !== rid ? r : { ...(r as object), isEnabled: action === "enable", ...(options.changedDefinition ? { prompt: "CONCURRENT_EDIT" } : {}) });
      return options.lostResponse ? Effect.fail(new RoutineError("outcome_unknown")) : Effect.sync(snapshot);
    },
  }))));
  const command = (action: "enable" | "disable" | "delete"): RoutineCommand => ({ action, agentId: AGENT, routineId: "notify-runtime",
    expectedRevision: snapshot().catalog.routines[0]!.revision, confirmed: true, operationId: "change-one" });
  return { run, command, snapshot, writes: () => writes, reads: () => reads, setRows: (v: unknown[]) => rows = v };
}

test("safe catalog never exposes prompt, key, URL, file path or arbitrary nested fields", () => {
  const catalog = projectNativeRoutines(AGENT, [base()]), encoded = JSON.stringify(catalog);
  expect(catalog.routines[0]).toMatchObject({ id: "notify-runtime", enabled: false, trigger: { type: "webhook" }, mutable: true });
  expect(catalog.coverage.complete).toBe(false);
  for (const word of ["PRIVATE_BODY", "PRIVATE_KEY", "PRIVATE/PATH", "private.invalid"]) expect(encoded).not.toContain(word);
  const altered = projectNativeRoutines(AGENT, [{ ...base(), lastRunAt: 5000, runs: [{ output: "PRIVATE_RUN" }] }]);
  expect(altered.routines[0]!.revision).toBe(catalog.routines[0]!.revision);
  expect(projectNativeRoutines(AGENT, [{ ...base(), prompt: "different" }]).routines[0]!.revision).not.toBe(catalog.routines[0]!.revision);
});

test("unknown triggers or nondefault session bindings remain read-only", async () => {
  for (const change of [{ trigger: { type: "new-provider", secret: "PRIVATE" } }, { sessionId: "foreign-session" }, { trigger: { type: "webhook", endpoint: "PRIVATE" } }]) {
    const f = fixture(); f.setRows([{ ...base(), ...change }]);
    const command = f.command("enable"); const result = await f.run(command);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "unsupported_trigger" } }); expect(f.writes()).toBe(0);
  }
});

test("enable changes only the exact native routine and returns observational, not CAS, proof", async () => {
  const f = fixture(), other = f.snapshot().catalog.routines[1];
  expect(await f.run(f.command("enable"))).toMatchObject({ _tag: "Success", success: {
    state: "requested_state_observed", nativeCompareAndSwap: false, webhookInvoked: false, inFlightRunsCancelled: false, automaticRetry: false } });
  expect(f.writes()).toBe(1); expect(f.reads()).toBe(2); expect(f.snapshot().catalog.routines[1]).toEqual(other);
});

test("an already-disabled routine requires no native write", async () => {
  const f = fixture(); expect(await f.run(f.command("disable"))).toMatchObject({ _tag: "Success", success: { state: "unchanged" } });
  expect(f.writes()).toBe(0); expect(f.reads()).toBe(1);
});

test("confirmation, exact IDs and revision validation happen before mutation", async () => {
  const f = fixture();
  for (const change of [{ confirmed: false }, { expectedRevision: "0".repeat(64) }, { routineId: "../outside" }, { agentId: "name" }]) {
    expect((await f.run({ ...f.command("enable"), ...change }))._tag).toBe("Failure"); expect(f.writes()).toBe(0);
  }
});

for (const scenario of ["lostResponse", "changedDefinition", "generationChanged", "postReadFails"] as const) test(`${scenario} leaves unknown without replay or a fabricated success`, async () => {
  const f = fixture({ [scenario]: true });
  expect(await f.run(f.command("enable"))).toMatchObject({ _tag: "Failure", failure: { reason: "outcome_unknown" } });
  expect(f.writes()).toBe(1);
});

test("delete reports absent in the observed windows, not a transaction or cancelled running work", async () => {
  const f = fixture(); expect(await f.run(f.command("delete"))).toMatchObject({ _tag: "Success", success: { state: "absent_in_returned_window", afterRevision: null, inFlightRunsCancelled: false } });
  expect(f.snapshot().catalog.routines.map(r => r.id)).toEqual(["other-task"]);
});

test("window saturation, duplicate identities and oversized definitions are not treated as complete", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...base(), id: `id-${i}`, prompt: "" }));
  expect(projectNativeRoutines(AGENT, rows).coverage).toMatchObject({ atLimit: true, complete: false });
  expect(() => projectNativeRoutines(AGENT, [...rows, { ...base(), id: "overflow" }])).toThrow();
  expect(() => projectNativeRoutines(AGENT, [base(), base()])).toThrow();
  expect(() => projectNativeRoutines(AGENT, [{ ...base(), prompt: "x".repeat(128 * 1024 + 1) }])).toThrow();
});

test("a daemon response is reprojected and cannot smuggle fields through an otherwise valid envelope", () => {
  const original = projectNativeRoutines(AGENT, [base()]);
  const result = projectRoutineResult({ action: "list", agentId: AGENT }, { ...original, credential: "PRIVATE", routines: [{ ...original.routines[0], prompt: "PRIVATE" }] });
  expect(result).toEqual(original); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(() => projectRoutineResult({ action: "list", agentId: AGENT }, { ...original, agentId: "wrong" })).toThrow();
  expect(() => projectRoutineResult({ action: "list", agentId: AGENT }, { ...original, coverage: { ...original.coverage, complete: true } })).toThrow();
});

test("remote mutation receipts must match the requested revision and action semantics", async () => {
  const f = fixture(), command = f.command("enable"), outcome = await f.run(command);
  if (outcome._tag !== "Success") throw Error("fixture_write_failed");
  const valid = outcome.success;
  expect(projectRoutineResult(command, valid)).toEqual(valid);
  for (const patch of [{ beforeRevision: "f".repeat(64) }, { state: "absent_in_returned_window", afterRevision: null },
    { state: "unchanged" }, { operationId: "other-operation" }, { automaticRetry: true }]) {
    expect(() => projectRoutineResult(command, { ...valid, ...patch })).toThrow();
  }
});

test("accessors are not evaluated while projecting native payloads", () => {
  let calls = 0;
  const hostile = Object.defineProperty(base(), "prompt", { get: () => { calls++; return "SECRET"; } });
  expect(() => projectNativeRoutines(AGENT, [hostile])).toThrow(); expect(calls).toBe(0);
});
