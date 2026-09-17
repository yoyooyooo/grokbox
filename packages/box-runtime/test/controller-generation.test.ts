import { describe, expect, test } from "bun:test";
import { expectedCompileReceipt } from "../src/internal/host/compile-receipt.ts";
import { profileFromSource } from "../src/internal/host/profile.ts";
import {
  controllerOperationId,
  observeControllerHostGeneration,
  observedAdoptCommitEligible,
  observedAdoptGenerationMatches,
  uniqueObservedAdoptIdentities,
} from "../src/internal/roots/controller-program.node.ts";
import type { ProcessIdentity } from "../src/internal/process/process-port.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "generation-a");
const host = { pid: 13, start: 102 };
const preloadSha256 = "f".repeat(64);
const marker = {
  ...host,
  operationId: "original-generation-operation",
  mode: "route" as const,
  modeld: false as const,
  compiled: true as const,
  transformed: true as const,
  compile: expectedCompileReceipt(profile),
  preloadSha256,
};

describe("controller loaded generation", () => {
  test("reuses only matching loaded preload and compiled profile", () => {
    expect(observedAdoptGenerationMatches(marker, host, profile, preloadSha256)).toBe(true);
    expect(observedAdoptGenerationMatches({ ...marker, preloadSha256: undefined }, host, profile, preloadSha256)).toBe(false);
    expect(observedAdoptGenerationMatches(marker, host, profile, "e".repeat(64))).toBe(false);
    expect(observedAdoptGenerationMatches({ ...marker, start: 101 }, host, profile, preloadSha256)).toBe(false);
    const nextProfile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "generation-b");
    expect(observedAdoptGenerationMatches(marker, host, nextProfile, preloadSha256)).toBe(false);
    expect(observedAdoptGenerationMatches({ ...marker, compile: undefined }, host, profile, preloadSha256)).toBe(false);
  });

  test("profile changes are new operations even if the preload filename and bytes stay unchanged", () => {
    const generation = { preloadSha256, profileSha256: expectedCompileReceipt(profile).profileSha256 };
    const first = controllerOperationId("apply", "/owned/box", generation);
    expect(controllerOperationId("apply", "/owned/box", { ...generation })).toBe(first);
    expect(controllerOperationId("apply", "/owned/box", { ...generation, profileSha256: "a".repeat(64) })).not.toBe(first);
    expect(controllerOperationId("apply", "/owned/box", { ...generation, preloadSha256: "a".repeat(64) })).not.toBe(first);
  });
});

const ident = (
  pid: number,
  ppid: number,
  role: "wrapper" | "supervisor" | "host",
): ProcessIdentity => ({
  pid,
  uid: 1000,
  start: 100 + pid,
  exe: "/exec-daemon/node",
  ppid,
  ancestry: [ppid],
  cmdline: role === "host"
    ? ["/exec-daemon/node", "/tmp/host-main.cjs"]
    : role === "supervisor"
      ? ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"]
      : ["bash", "/usr/local/bin/supervise-sand-supervisor"],
});

describe("controller operation Host lifetime", () => {
  test("same process lifetime reuses the key; PID reuse and a later stop/start do not", () => {
    const wrapper = ident(11, 1, "wrapper");
    const supervisor = ident(12, 11, "supervisor");
    const current = ident(13, 12, "host");
    let rows = [wrapper, supervisor, current];
    let gatewayPid = current.pid;
    const live = {
      processes: {
        list: () => rows,
        inspect: (pid: number) => rows.find((row) => row.pid === pid) ?? null,
        signal: () => { throw new Error("read-only observation cannot signal"); },
      },
      classify: (row: ProcessIdentity) => row.pid === 11 ? "wrapper" as const : row.pid === 12 ? "supervisor" as const : "host" as const,
      gatewayPid: () => gatewayPid,
      hostBundlePath: "/tmp/host-main.cjs",
      readHostSha: () => null,
    };
    const first = observeControllerHostGeneration(live);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(observeControllerHostGeneration(live)).toBe(first);
    const key = controllerOperationId("apply", "/owned/box", { preloadSha256, hostGeneration: first! });
    rows = [wrapper, supervisor, { ...current, start: current.start + 1 }];
    const reusedPid = observeControllerHostGeneration(live);
    expect(reusedPid).not.toBe(first);
    expect(controllerOperationId("apply", "/owned/box", { preloadSha256, hostGeneration: reusedPid! })).not.toBe(key);
    rows = [wrapper, supervisor, { ...current, pid: 14, start: current.start + 2 }];
    gatewayPid = 14;
    expect(observeControllerHostGeneration(live)).not.toBe(first);
    gatewayPid = 13;
    expect(observeControllerHostGeneration(live)).toBeNull();
    gatewayPid = 14;
    rows.push({ ...current, pid: 15 });
    expect(observeControllerHostGeneration(live)).toBeNull();
    rows = [wrapper, supervisor];
    expect(observeControllerHostGeneration(live)).toBeNull();
  });

  test("unstable process inspection or discovery never mints a key", () => {
    const supervisor = ident(12, 11, "supervisor");
    const current = ident(13, 12, "host");
    const live = {
      processes: {
        list: () => [supervisor, current],
        inspect: (pid: number) => pid === 12 ? supervisor : { ...current, start: current.start + 1 },
        signal: () => { throw new Error("must not signal"); },
      },
      classify: (row: ProcessIdentity) => row.pid === 12 ? "supervisor" as const : "host" as const,
      gatewayPid: () => 13,
      hostBundlePath: "/tmp/host-main.cjs",
      readHostSha: () => null,
    };
    expect(observeControllerHostGeneration(live)).toBeNull();
    let discoveryReads = 0;
    expect(observeControllerHostGeneration({ ...live,
      processes: { ...live.processes, inspect: (pid: number) => pid === 12 ? supervisor : current },
      gatewayPid: () => ++discoveryReads === 1 ? 13 : 14,
    })).toBeNull();
  });
});

describe("observed adopt commit eligibility", () => {
  const supervisor = { pid: 12 };
  const base = {
    marker,
    host,
    supervisor,
    profile,
    preloadSha256,
    hasGrokboxPreload: true,
  };

  test("orphan Host with unique supervisor and matching generation is eligible without prove.mode", () => {
    expect(observedAdoptCommitEligible(base)).toBe(true);
    expect(observedAdoptCommitEligible({ ...base, host: { pid: 13, start: 102 } })).toBe(true);
  });

  test("missing supervisor is ineligible — do not invent PIDs", () => {
    expect(observedAdoptCommitEligible({ ...base, supervisor: null })).toBe(false);
    expect(observedAdoptCommitEligible({ ...base, supervisor: { pid: 0 } })).toBe(false);
  });

  test("marker or generation mismatch stays ineligible", () => {
    expect(observedAdoptCommitEligible({ ...base, hasGrokboxPreload: false })).toBe(false);
    expect(observedAdoptCommitEligible({ ...base, preloadSha256: "e".repeat(64) })).toBe(false);
    expect(observedAdoptCommitEligible({ ...base, marker: { ...marker, start: 101 } })).toBe(false);
    expect(observedAdoptCommitEligible({
      ...base,
      profile: profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "generation-b"),
    })).toBe(false);
  });

  test("census yields unique Host+supervisor including post-handoff orphan; duplicate/missing is null", () => {
    const wrapper = ident(11, 1, "wrapper");
    const official = ident(12, 11, "supervisor");
    const orphan = { ...ident(13, 53, "host"), start: 102, ancestry: [53, 1] };
    const rows = [wrapper, official, orphan];
    const classify = (row: ProcessIdentity) => {
      if (row.cmdline.includes("/usr/local/bin/supervise-sand-supervisor")) return "wrapper" as const;
      if (row.cmdline.includes("/usr/local/bin/sand-supervisor.mjs")) return "supervisor" as const;
      if (row.cmdline.includes("/tmp/host-main.cjs")) return "host" as const;
      return null;
    };
    const port = {
      list: () => rows,
      inspect: (pid: number) => rows.find((row) => row.pid === pid) ?? null,
      signal: () => ({ ok: false as const, reason: "not-found" as const }),
    };
    expect(uniqueObservedAdoptIdentities(port, classify)).toEqual({ host: orphan, supervisor: official });
    expect(uniqueObservedAdoptIdentities({ ...port, list: () => [wrapper, official] }, classify)).toBeNull();
    expect(uniqueObservedAdoptIdentities({
      ...port,
      list: () => [...rows, { ...orphan, pid: 14, start: 103 }],
    }, classify)).toBeNull();
  });
});
