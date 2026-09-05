import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdentityDeactivate, runIdentityOperation } from "../src/identity-op.ts";
import { armGuardian } from "../src/guardian.ts";
import type { PatchProfile } from "../src/transform.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

const reviewed: PatchProfile = {
  profileId: "reviewed",
  sourceSha256: "sha-reviewed",
  transformedSourceSha256: "sha-transformed",
  slices: [
    { id: "create-session", startAnchor: "a", endAnchor: "b", find: "c", replacement: "d" },
    { id: "agent-id", startAnchor: "e", endAnchor: "f", find: "g", replacement: "h" },
  ],
};

function classify(tree: FakeProcessTree) {
  return (ident: { pid: number }) => {
    const row = tree.roles().find((role) => role.pid === ident.pid);
    if (row?.role === "wrapper" || row?.role === "supervisor" || row?.role === "host") return row.role;
    return null;
  };
}

async function ephemeral() {
  return await mkdtemp(join(tmpdir(), "grokbox-op-"));
}

function guard(tree: FakeProcessTree, frozen: Array<{ pid: number }>) {
  const g = armGuardian({
    wrapper: frozen[0] as never,
    processes: tree,
    deadlineMs: 5000,
    now: () => 0,
    wait: hangUntilAbort(),
  });
  return { ok: true as const, release: () => g.close() };
}

describe("identity operation preflight (zero-signal abort)", () => {
  test("unknown SHA, duplicate role, lock conflict, and stale marker do not signal", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    tree.spawn("host", { parent: supervisor });
    const root = await ephemeral();

    const unknown = await runIdentityOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-other",
      ephemeralRoot: root,
      operationId: "op-1",
      readMarker: () => null,
      waitHostGone: async () => true,
      supervisorRelaunch: async () => tree.spawn("host", { parent: supervisor }),
      waitReady: async () => null,
      armGuardian: async (frozen) => guard(tree, frozen),
      now: () => 0,
    });
    expect(unknown).toMatchObject({ ok: false, code: "unknown-sha", signaled: false });
    expect(tree.signals).toEqual([]);

    tree.spawn("host", { parent: supervisor });
    const dupRoot = await ephemeral();
    const dup = await runIdentityOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: dupRoot,
      operationId: "op-2",
      readMarker: () => null,
      waitHostGone: async () => true,
      supervisorRelaunch: async () => null,
      waitReady: async () => null,
      armGuardian: async (frozen) => guard(tree, frozen),
      now: () => 0,
    });
    expect(dup).toMatchObject({ ok: false, code: "duplicate-role", signaled: false });

    const tree2 = new FakeProcessTree();
    const w = tree2.spawn("wrapper");
    const s = tree2.spawn("supervisor", { parent: w });
    const h = tree2.spawn("host", { parent: s });
    const lockRoot = await ephemeral();
    const { acquireExclusiveLock, operationLockPath } = await import("../src/op-lock.ts");
    const held = await acquireExclusiveLock(operationLockPath(lockRoot));
    expect(held.ok).toBe(true);
    const locked = await runIdentityOperation({
      processes: tree2,
      classify: classify(tree2),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: lockRoot,
      operationId: "op-3",
      readMarker: () => null,
      waitHostGone: async () => true,
      supervisorRelaunch: async () => null,
      waitReady: async () => null,
      armGuardian: async (frozen) => guard(tree2, frozen),
      now: () => 0,
    });
    expect(locked).toMatchObject({ ok: false, code: "lock-conflict", signaled: false });
    expect(tree2.signals).toEqual([]);
    if (held.ok) await held.lock.release();

    const stale = await runIdentityOperation({
      processes: tree2,
      classify: classify(tree2),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await ephemeral(),
      operationId: "op-4",
      readMarker: () => ({
        operationId: "old",
        pid: h.pid,
        mode: "identity",
        transformed: true,
        compiled: true,
        modeld: false,
      }),
      waitHostGone: async () => true,
      supervisorRelaunch: async () => null,
      waitReady: async () => null,
      armGuardian: async (frozen) => guard(tree2, frozen),
      now: () => 0,
    });
    expect(stale).toMatchObject({ ok: false, code: "stale-marker", signaled: false });
    expect(tree2.signals).toEqual([]);
  });
});

describe("identity operation happy path and fail-closed deactivate", () => {
  test("supervisor-owned replacement, wait old host exit, attest real identity", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const result = await runIdentityOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await ephemeral(),
      operationId: "op-ok",
      readMarker: () => null,
      waitHostGone: async (old) => tree.inspect(old.pid) === null,
      supervisorRelaunch: async (sup) => tree.spawn("host", { parent: sup }),
      waitReady: async (pid) => ({
        operationId: "op-ok",
        pid,
        mode: "identity",
        transformed: true,
        compiled: true,
        modeld: false,
      }),
      armGuardian: async (frozen) => guard(tree, frozen),
      now: () => 10,
    });
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe("attested");
    expect(result.host?.ppid).toBe(supervisor.pid);
    expect(tree.alive(host.pid)).toBe(false);
    expect(tree.stopped(wrapper.pid)).toBe(false);
  });

  test("post-freeze SHA change resumes wrapper; failed deactivate cannot clear attestation", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    let sha = "sha-reviewed";
    const freezeFail = await runIdentityOperation({
      processes: tree,
      classify: classify(tree),
      reviewedProfile: reviewed,
      diskSha: () => (tree.stopped(wrapper.pid) ? "sha-drift" : sha),
      ephemeralRoot: await ephemeral(),
      operationId: "op-fail",
      readMarker: () => null,
      waitHostGone: async () => true,
      supervisorRelaunch: async () => null,
      waitReady: async () => null,
      armGuardian: async (frozen) => guard(tree, frozen),
      now: () => 0,
    });
    expect(freezeFail.ok).toBe(false);
    expect(freezeFail.code).toBe("disk-sha-changed");
    expect(tree.stopped(wrapper.pid)).toBe(false);
    expect(tree.alive(host.pid)).toBe(true);

    let cleared = false;
    const badDeactivate = await runIdentityDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await ephemeral(),
      attestation: { identity: { ...host, start: host.start + 99 }, diskSha: "sha-reviewed" },
      waitHostGone: async () => true,
      waitReplacement: async () => null,
      hasGrokboxPreload: () => false,
      clearAttestation: async () => {
        cleared = true;
      },
    });
    expect(badDeactivate.ok).toBe(false);
    expect(badDeactivate.code).toBe("deactivate-signal-failed");
    expect(cleared).toBe(false);
    expect(tree.alive(host.pid)).toBe(true);
  });
});
