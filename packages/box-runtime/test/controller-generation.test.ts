import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { expectedCompileReceipt } from "../src/internal/host/compile-receipt.ts";
import { profileFromSource } from "../src/internal/host/profile.ts";
import {
  commitObservedAdopt, type ObservedAdoptState,
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


// Actual file writers and Linux identity lease; only native observations are
// synthetic. This remains in the original controller-generation test entry.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authority from "../src/internal/io/authority.node.ts";
import * as adopt from "../src/internal/process/transient-adopt.ts";
import * as lease from "../src/internal/io/operation-lease.node.ts";
const ownedRoots: string[] = [];
afterEach(async () => { await Promise.all(ownedRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function observedFixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-observed-commit-")); ownedRoots.push(root);
  let reads = 0;
  const view: ObservedAdoptState = {
    host: { ...ident(13, 53, "host"), start: 102 }, supervisor: ident(12, 11, "supervisor"),
    profile, marker: { ...marker }, preloadSha256, diskSha256: profile.sourceSha256, gatewayPid: 13,
    hasGrokboxPreload: true, supervisorPreloaded: false,
  };
  const input = { operationId: "fresh-controller-request", ephemeralRoot: root,
    observe: () => { reads++; return structuredClone(view); }, modeldReady: async () => true };
  return { root, view, input, reads: () => reads };
}
(process.platform === "linux" ? describe : describe.skip)("observed adoption shares the original identity lease", () => {
  test("held identity lease blocks all observation, attestation and journal writes", async () => {
    const f = await observedFixture();
    const other = await lease.acquireOperationLease(lease.operationLockPath(f.root), "other-owner");
    expect(other.ok).toBe(true); if (!other.ok) return;
    try {
      expect(await commitObservedAdopt(f.input)).toMatchObject({ ok: false, code: "lock-conflict", signaled: false });
      expect(f.reads()).toBe(0); expect(await authority.readAttestation(f.root)).toBeNull();
      expect(await adopt.readAdoptOpState(f.root)).toBeNull();
    } finally { await other.lock.release(); }
  });
  test("stable exact generation commits original identities without launching a process", async () => {
    const f = await observedFixture(); const result = await commitObservedAdopt(f.input);
    expect(result).toMatchObject({ ok: true, signaled: false, coverage: "attested", host: f.view.host });
    expect(await authority.readAttestation(f.root)).toMatchObject({ operationId: marker.operationId, identity: f.view.host, compile: marker.compile });
    expect(await adopt.readAdoptOpState(f.root)).toMatchObject({ phase: "attested", operationId: marker.operationId });
    expect((await lease.inspectOperationLease(lease.operationLockPath(f.root))).observation.state).toBe("missing");
  });
  test("no reusable generation releases the lease and creates no evidence", async () => {
    const f = await observedFixture();
    expect(await commitObservedAdopt({ ...f.input, observe: () => null })).toBeNull();
    expect(await authority.readAttestation(f.root)).toBeNull(); expect(await adopt.readAdoptOpState(f.root)).toBeNull();
    const next = await lease.acquireOperationLease(lease.operationLockPath(f.root), "full-adopt-owner");
    expect(next.ok).toBe(true); if (next.ok) await next.lock.release();
  });
  for (const change of ["host", "supervisor", "marker", "profile", "preload", "source", "gateway"] as const) {
    test(`a ${change} change during readiness does not become new commit authority`, async () => {
      const f = await observedFixture();
      const result = await commitObservedAdopt({ ...f.input, modeldReady: async () => {
        if (change === "host") f.view.host.start++;
        else if (change === "supervisor") f.view.supervisor.start++;
        else if (change === "marker") f.view.marker.operationId = "different-operation";
        else if (change === "profile") f.view.profile = { ...f.view.profile, profileId: "changed-profile" };
        else if (change === "preload") f.view.preloadSha256 = "1".repeat(64);
        else if (change === "source") f.view.diskSha256 = "2".repeat(64);
        else f.view.gatewayPid = 999;
        return true;
      } });
      expect(result).toMatchObject({ ok: false, code: "observed-generation-changed" });
      expect(await authority.readAttestation(f.root)).toBeNull(); expect(await adopt.readAdoptOpState(f.root)).toBeNull();
    });
  }
  test("unready modeld cannot acquire a successful route attestation", async () => {
    const f = await observedFixture();
    expect(await commitObservedAdopt({ ...f.input, modeldReady: async () => false })).toMatchObject({ ok: false, code: "modeld_not_ready" });
    expect(await authority.readAttestation(f.root)).toBeNull();
  });
  test("identity lease stays held across awaited readiness and original writes", async () => {
    const f = await observedFixture(); let release!: () => void; let entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const running = commitObservedAdopt({ ...f.input, modeldReady: async () => { entered(); await wait; return true; } });
    try {
      await arrived;
      const competitor = await lease.acquireOperationLease(lease.operationLockPath(f.root), "competitor");
      expect(competitor.ok).toBe(false); if (competitor.ok) await competitor.lock.release();
    } finally { release(); }
    expect(await running).toMatchObject({ ok: true });
  });
  test("observed drift after attestation write preserves evidence but refuses success", async () => {
    const f = await observedFixture(), write = authority.writeAttestation;
    const spy = spyOn(authority, "writeAttestation").mockImplementation(async (root, value) => { await write(root, value); f.view.host.start++; });
    try {
      expect(await commitObservedAdopt(f.input)).toMatchObject({ ok: false, code: "observed-generation-changed", committedAttestation: { identity: { start: 102 } } });
      expect(await adopt.readAdoptOpState(f.root)).toMatchObject({ phase: "commit-attestation" });
    } finally { spy.mockRestore(); }
  });
  test("journal readback must match the original completed declaration", async () => {
    const f = await observedFixture(), write = adopt.writeAdoptOpState;
    const spy = spyOn(adopt, "writeAdoptOpState").mockImplementation(async (root, value) => write(root,
      value.phase === "attested" ? { ...value, phase: "recovery-required" } : value));
    try { expect(await commitObservedAdopt(f.input)).toMatchObject({ ok: false, code: "journal-uncommitted" }); }
    finally { spy.mockRestore(); }
  });
  test("lease-release uncertainty cannot report successful adoption", async () => {
    const f = await observedFixture(), acquire = lease.acquireOperationLease;
    const spy = spyOn(lease, "acquireOperationLease").mockImplementation(async (...args) => {
      const held = await acquire(...args); if (!held.ok) return held;
      return { ...held, lock: { ...held.lock, release: async () => { await held.lock.release(); throw Error("synthetic-lost-release-receipt"); } } };
    });
    try { expect(await commitObservedAdopt(f.input)).toMatchObject({ ok: false, code: "operation-lock-release-failed", committedAttestation: { operationId: marker.operationId } }); }
    finally { spy.mockRestore(); }
  });
});
