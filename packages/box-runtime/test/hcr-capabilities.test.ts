import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { assessLoadedHostCapabilities, loadedHostCapabilities, projectLoadedHostCapabilities, type LoadedHostIdentity } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "../src/internal/host/ownership-read.ts";
import { OWNERSHIP_READ_SLICES } from "../src/internal/host/ownership-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { operatorNext } from "../../cli/src/commands/operator.ts";
import { controllerApplyCompleted, projectCommittedHostAlignment } from "../../cli/src/host-capabilities.ts";
import { OWNERSHIP_SHAPED_HOST } from "./ownership-shaped-host.ts";

const loaded: LoadedHostIdentity = { pid: 12, start: 34, profileSha256: "a".repeat(64), sourceSha256: "b".repeat(64), transformedSha256: "c".repeat(64) };
function gateway(source: string, reader: unknown) {
  const calls: string[] = [];
  const context = createContext({
    Symbol, globalThis: { [Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)]: reader },
    deps: { getHealth: () => { calls.push("health"); return { isBusy: false }; }, extensions: { api(name: string) {
      calls.push(name);
      if (name === "host-upgrade") return { getVersionState: () => ({ version: "fixture" }) };
      throw new Error("No auth, roster, execution or mutation capability is permitted in this probe");
    } } },
    BASE_HOST_CAPABILITIES: { fixture: true },
  });
  runInContext(source + "\nglobalThis.api = ownershipFixtureAPI;", context);
  return { calls, api: (context.globalThis as { api: { getHostStatus(input: unknown): Promise<Record<string, unknown>> } }).api };
}

test("actual applied wrapper and installed reader report loaded identity without native reads", async () => {
  const transformed = transformUnchecked(OWNERSHIP_SHAPED_HOST, OWNERSHIP_READ_SLICES);
  if (!transformed.ok) throw Error(transformed.code);
  const g = gateway(transformed.source, bindHostOwnershipRead({ loaded }));
  expect(await g.api.getHostStatus({})).toEqual({ version: "fixture", isBusy: false, capabilities: { fixture: true } });
  const result = await g.api.getHostStatus({ grokboxRuntimeCapabilities: true });
  const evidence = projectLoadedHostCapabilities(result.grokboxRuntimeCapabilities);
  expect(evidence?.loaded).toEqual(loaded);
  expect(assessLoadedHostCapabilities(evidence, { gatewayPid: loaded.pid, hostStart: loaded.start, profile: loaded })).toMatchObject({ state: "ready", reason: "matched" });
  expect(g.calls).toEqual(["host-upgrade", "health", "host-upgrade", "health"]);
  expect(result.grokboxOwnership).toBeUndefined();
});

test("old wrapper, old reader and unbound reader cannot advertise ready", async () => {
  const transformed = transformUnchecked(OWNERSHIP_SHAPED_HOST, OWNERSHIP_READ_SLICES);
  if (!transformed.ok) throw Error(transformed.code);
  const legacy = async () => { throw Error("must not invoke the legacy reader"); };
  for (const [source, reader] of [[OWNERSHIP_SHAPED_HOST, bindHostOwnershipRead({ loaded })], [transformed.source, legacy], [transformed.source, bindHostOwnershipRead()]] as const) {
    const result = await gateway(source, reader).api.getHostStatus({ grokboxRuntimeCapabilities: true });
    expect(assessLoadedHostCapabilities(result.grokboxRuntimeCapabilities, { gatewayPid: loaded.pid, profile: loaded }).state).toBe("not_instrumented");
  }
});

test("reader snapshots loaded identity and requires a supported wrapper revision", () => {
  const mutable = { ...loaded };
  const reader = bindHostOwnershipRead({ loaded: mutable });
  mutable.pid = 999;
  expect(reader.capabilities(1)?.loaded.pid).toBe(12);
  expect(reader.capabilities(2)).toBeNull();
});

test("profile/generation mismatches and missing expectations never pass", () => {
  const value = loadedHostCapabilities(loaded, 1);
  expect(assessLoadedHostCapabilities(value, { gatewayPid: 13, profile: loaded })).toMatchObject({ state: "incompatible", reason: "generation_mismatch" });
  expect(assessLoadedHostCapabilities(value, { gatewayPid: 12, hostStart: 35, profile: loaded })).toMatchObject({ state: "incompatible", reason: "generation_mismatch" });
  expect(assessLoadedHostCapabilities(value, { gatewayPid: 12 })).toMatchObject({ state: "unavailable", reason: "expected_profile_unavailable" });
  for (const field of ["profileSha256", "sourceSha256", "transformedSha256"] as const) {
    expect(assessLoadedHostCapabilities(value, { gatewayPid: 12, profile: { ...loaded, [field]: "d".repeat(64) } }))
      .toMatchObject({ state: "incompatible", reason: "loaded_profile_mismatch" });
  }
});

test("capability projection strips arbitrary payload and does not invoke getters", () => {
  const value = loadedHostCapabilities(loaded, 1)!;
  expect(projectLoadedHostCapabilities({ ...value, secret: "PRIVATE", loaded: { ...loaded, secret: "PRIVATE" } })).toEqual(value);
  let reads = 0;
  expect(projectLoadedHostCapabilities({ ...value, get loaded() { reads++; return loaded; } })).toBeUndefined();
  expect(reads).toBe(0);
  expect(assessLoadedHostCapabilities({ ...value, version: 2 }, { gatewayPid: 12, profile: loaded })).toMatchObject({ state: "incompatible", reason: "invalid_manifest" });
});

test("only explicit committed controller outcomes qualify, without invoking accessors", () => {
  for (const value of [null, {}, { outcome: "signaled" }, { outcome: "noop", reason: null },
    ...["partial", "unknown", "recovery-required", "refused"].map(outcome => ({ outcome, reason: "commit-failed" }))]) {
    expect(controllerApplyCompleted(value)).toBe(false);
  }
  expect(controllerApplyCompleted({ outcome: "signaled", reason: null })).toBe(true);
  expect(controllerApplyCompleted({ outcome: "converged", reason: "duplicate-operation" })).toBe(true);
  let reads = 0;
  expect(controllerApplyCompleted({ get outcome() { reads++; return "signaled"; }, reason: null })).toBe(false);
  expect(reads).toBe(0);
});

test("runtime alignment requires committed bridge, clear recovery and accepting route service", () => {
  // Minimal synthetic projection input: unrelated observation facets are never consulted.
  const fixture = () => ({ facets: {
    bridge: { gap: null as string | null, value: { origin: "grokbox-attested", reason: null as string | null, actual: "route", desired: "route" } },
    recovery: { gap: null as string | null, value: { pending: false as boolean | null } },
    modeld: { gap: null as string | null, value: { ready: true, execution: { accepting: true } } },
  } });
  const check = (value: ReturnType<typeof fixture>) => projectCommittedHostAlignment(value as unknown as Parameters<typeof projectCommittedHostAlignment>[0]);
  expect(check(fixture())).toEqual({ state: "ready", reason: "matched" });
  const pending = fixture(); pending.facets.recovery.value.pending = true;
  expect(check(pending)).toMatchObject({ state: "blocked", reason: "recovery_pending" });
  const stale = fixture(); stale.facets.bridge.value.reason = "stale_attestation";
  expect(check(stale)).toMatchObject({ state: "blocked", reason: "bridge_uncommitted" });
  const wrongMode = fixture(); wrongMode.facets.bridge.value.desired = "disabled";
  expect(check(wrongMode)).toMatchObject({ state: "blocked", reason: "bridge_uncommitted" });
  const modeld = fixture(); modeld.facets.modeld.value.execution.accepting = false;
  expect(check(modeld)).toMatchObject({ state: "blocked", reason: "modeld_not_ready" });
  const gap = fixture(); gap.facets.recovery.gap = "invalid";
  expect(check(gap)).toMatchObject({ state: "blocked", reason: "recovery_pending" });
});

test("doctor never maps unknown observation or missing bridge proof to none", () => {
  expect(operatorNext({ daemon: "up", host: "unknown", hostReason: "observation_unavailable" })).toBe("grokbox runtime status --json");
  const base = { daemon: "up", host: "custom", hostReason: null, modeldAdmission: "ready", liveSha: loaded.sourceSha256,
    committed: { state: "ready", reason: "matched" } } as const;
  expect(operatorNext(base)).not.toBe("none");
  expect(operatorNext({ ...base, hostCapabilities: { state: "not_instrumented", reason: "missing_manifest" } })).toContain("--capability ownership-local");
  expect(operatorNext({ ...base, hostCapabilities: { state: "ready", reason: "matched" } })).toBe("none");
  expect(operatorNext({ ...base, committed: undefined, hostCapabilities: { state: "ready", reason: "matched" } })).toBe("grokbox runtime status --json");
  expect(operatorNext({ ...base, committed: { state: "blocked", reason: "recovery_pending" },
    hostCapabilities: { state: "ready", reason: "matched" } })).toBe("grokbox runtime status --json");
  expect(operatorNext({ ...base, hostCapabilities: { state: "incompatible", reason: "loaded_profile_mismatch" } })).toBe("grokbox host restart");
  expect(operatorNext({ ...base, hostCapabilities: { state: "incompatible", reason: "generation_mismatch" } })).toBe("grokbox runtime status --json");
  expect(operatorNext({ ...base, modeldAdmission: "blocked", hostCapabilities: { state: "ready", reason: "matched" } })).toBe("grokbox runtime modeld status");
});
