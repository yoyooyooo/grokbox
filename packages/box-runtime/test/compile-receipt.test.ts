import { describe, expect, spyOn, test } from "bun:test";
import * as liveProc from "../src/live-proc.ts";
import { liveH3AdoptAdapter, wireLiveManualReadopt } from "../src/live-readopt.ts";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attestationPath, readAttestation, writeAttestation } from "../src/attestation.ts";
import { expectedCompileReceipt, profileBytes } from "../src/compile-receipt.ts";
import { runManualReadopt } from "../src/coordinator.ts";
import { coordinatorStatePath, reviewedProfilePath } from "../src/paths.ts";
import { writeReviewedProfileFromCopy } from "../src/reviewed-profile.ts";
import { adoptOpStatePath, readAdoptOpState } from "../src/transient-adopt.ts";
import { nextProfile, reviewed } from "./admission-fixture.ts";
import { receiptFixture } from "./receipt-fixture.ts";

async function expectNoRetry(f: Awaited<ReturnType<typeof receiptFixture>>) {
  const signals = [...f.tree.signals];
  const launches = f.counts.launches;
  for (let i = 0; i < 2; i += 1) {
    const next = await runManualReadopt(f.input);
    expect(next.reconcile).toBe("recovery-required");
    expect(next.signaled).toBe(false);
    expect(next.injected).toBe(false);
    expect(f.counts.launches).toBe(launches);
    expect(f.tree.signals).toEqual(signals);
  }
}

describe("compile to committed receipt (fake processes, real isolated artifacts)", () => {
  test.each(["identity", "route"] as const)("%s commits the marker-derived generation exactly once, then no-ops", async (mode) => {
    const f = await receiptFixture(mode);
    const result = await runManualReadopt(f.input);
    expect(result.reconcile, JSON.stringify(result)).toBe("converged");
    expect(result.signaled).toBe(true);
    expect(result.injected).toBe(true);
    const record = await readAttestation(f.ephemeralRoot);
    expect(record).not.toBeNull();
    expect(result.committedAttestation).toEqual(record!);
    expect(record?.compile).toEqual(f.launch.marker?.compile);
    expect(record?.compile).toEqual(expectedCompileReceipt(reviewed));
    expect(record?.pid).toBe(f.launch.marker?.pid);
    expect(record?.start).toBe(f.launch.marker?.start);
    expect(record?.pid).not.toBe(f.host.pid);
    expect(record?.operationId).toBe(f.launch.marker?.operationId);
    expect(record?.modeld).toBe(mode === "route");
    expect(f.launch.marker?.modeld).toBe(false);
    expect((await readAdoptOpState(f.ephemeralRoot))?.compile).toEqual(record?.compile);
    expect(f.counts).toEqual({ prepares: 1, launches: 1, markers: 1 });
    const signals = [...f.tree.signals];
    for (let i = 0; i < 3; i += 1) {
      expect(await runManualReadopt(f.input)).toMatchObject({ reconcile: "converged", signaled: false, injected: false });
      expect(await readAttestation(f.ephemeralRoot)).toEqual(record);
      expect(f.tree.signals).toEqual(signals);
      expect(f.counts).toEqual({ prepares: 1, launches: 1, markers: 1 });
    }
  });

  test("authoring races with launch: only pinned bytes are compiled/signed, never the later reviewed.json", async () => {
    const f = await receiptFixture();
    const prepare = f.input.adopt!.prepareTempLaunch!;
    f.input.adopt!.prepareTempLaunch = async (profile) => {
      await prepare(profile);
      await writeReviewedProfileFromCopy({
        hostBundle: f.sourcePath, destDir: dirname(reviewedProfilePath(f.root)),
        slices: nextProfile.slices, profileId: nextProfile.profileId,
      });
    };
    const result = await runManualReadopt(f.input);
    expect(result.reconcile).toBe("converged");
    expect(result.committedAttestation?.compile).toEqual(expectedCompileReceipt(reviewed));
    expect(JSON.parse(await readFile(reviewedProfilePath(f.root), "utf8"))).toEqual(nextProfile);
    expect(await readFile(f.launch.profilePath, "utf8")).toBe(profileBytes(reviewed));
    expect((await stat(f.launch.profilePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(f.launch.profilePath))).mode & 0o777).toBe(0o700);
    expect(f.counts.launches).toBe(1);
  });

  test("public manual adapter pins the admitted profile and delegates the actual receipt writer", async () => {
    const f = await receiptFixture();
    const adopt = f.input.adopt!;
    const factory = spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts").mockImplementation(() => ({
      processes: f.tree, classify: f.input.classify!, target: adopt.target,
      waitHostGone: adopt.waitGone, supervisorRelaunch: async () => null, waitReady: adopt.waitReady,
      hasGrokboxPreload: adopt.hasGrokboxPreload, spawnTempSupervisor: adopt.spawnTempSupervisor,
      waitNewHost: adopt.waitNewHost, readGatewayPid: adopt.readGatewayPid,
      applyLaunchEnv: async (env) => {
        f.launch.profilePath = env.GROKBOX_PATCH_PROFILE!;
        await writeReviewedProfileFromCopy({ hostBundle: f.sourcePath, destDir: dirname(reviewedProfilePath(f.root)),
          slices: nextProfile.slices, profileId: nextProfile.profileId });
      },
    }));
    const env = spyOn(liveProc, "readNamedProcEnv").mockImplementation(() => ({ HOME: f.root }));
    try {
      const wired = wireLiveManualReadopt({ root: f.root, ephemeralRoot: f.ephemeralRoot, mode: "route", now: f.input.now });
      wired.adopt.armGuardian = adopt.armGuardian; // fake guardian, never launch a live helper here
      const result = await runManualReadopt({ ...f.input, ...wired, envHas: f.input.envHas });
      expect(result.reconcile, JSON.stringify(result)).toBe("converged");
      expect(result.committedAttestation?.compile).toEqual(expectedCompileReceipt(reviewed));
      expect(f.launch.profilePath).not.toBe(reviewedProfilePath(f.root));
      expect(f.counts.launches).toBe(1);
      expect(wired.adopt.persistAttestation).toBeUndefined();
    } finally { env.mockRestore(); factory.mockRestore(); }
  });

  test.each(["profileId", "profileSha256", "sourceSha256", "transformedSha256", "missing", "pid", "start", "operationId", "modeld"])(
    "wrong marker %s cannot commit or retry", async (field) => {
      const f = await receiptFixture();
      const ready = f.input.adopt!.waitReady;
      f.input.adopt!.waitReady = async (pid) => {
        const marker = (await ready(pid))!;
        if (field === "missing") return { ...marker, compile: undefined };
        if (field === "pid") return { ...marker, pid: pid + 1 };
        if (field === "start") return { ...marker, start: marker.start! + 1 };
        if (field === "operationId") return { ...marker, operationId: "old-operation" };
        if (field === "modeld") return { ...marker, modeld: true } as unknown as typeof marker;
        return { ...marker, compile: { ...marker.compile!, [field]: "wrong" } };
      };
      const result = await runManualReadopt(f.input);
      expect(result).toMatchObject({ reconcile: "recovery-required", reason: "marker-mismatch", signaled: true, injected: false });
      expect(result.committedAttestation).toBeUndefined();
      expect(await readAttestation(f.ephemeralRoot)).toBeNull();
      expect((await readAdoptOpState(f.ephemeralRoot))?.phase).toBe("recovery-required");
      await expectNoRetry(f);
    },
  );

  test.each(["compile", "commit-journal", "persist", "final-readback"])("modeld drop at %s preserves signals, not a false route success", async (stage) => {
    const f = await receiptFixture();
    if (stage === "compile") {
      const ready = f.input.adopt!.waitReady;
      f.input.adopt!.waitReady = async (pid) => { const marker = await ready(pid); f.modeld.ready = false; return marker; };
    } else if (stage === "persist") {
      f.input.adopt!.persistAttestation = async (record) => {
        await writeAttestation(f.ephemeralRoot, record);
        f.modeld.ready = false;
      };
    } else {
      f.input.modeldReady = async () => (await readAdoptOpState(f.ephemeralRoot))?.phase !==
        (stage === "commit-journal" ? "commit-attestation" : "attested");
    }
    const result = await runManualReadopt(f.input);
    expect(result).toMatchObject({ reconcile: "recovery-required", reason: "modeld_not_ready", signaled: true, injected: false });
    expect(f.launch.marker?.modeld).toBe(false);
    if (stage === "compile" || stage === "commit-journal") {
      expect(await readAttestation(f.ephemeralRoot)).toBeNull();
      expect(result.committedAttestation).toBeUndefined();
    } else {
      const record = await readAttestation(f.ephemeralRoot);
      expect(record).not.toBeNull();
      expect(result.committedAttestation).toEqual(record!);
      expect(result.committedAttestation?.compile).toEqual(f.launch.marker?.compile);
    }
    f.modeld.ready = true;
    await expectNoRetry(f);
  });

  test("modeld loss during coordinator persistence is not hidden by an earlier committed operation", async () => {
    const f = await receiptFixture();
    f.input.modeldReady = async () => {
      try { return JSON.parse(await readFile(coordinatorStatePath(f.root), "utf8")).mutationCount === 0; }
      catch { return true; }
    };
    const result = await runManualReadopt(f.input);
    expect(result).toMatchObject({ reconcile: "recovery-required", reason: "modeld_not_ready", signaled: true, injected: true });
    const record = await readAttestation(f.ephemeralRoot);
    expect(record).not.toBeNull();
    expect(result.committedAttestation).toEqual(record!);
    await expectNoRetry(f);
  });

  test("deactivate succeeds, adopt admission rejects: aggregate keeps old TERM and original attempt key", async () => {
    const f = await receiptFixture("route", true);
    const replacement = f.input.waitReplacement!;
    f.input.waitReplacement = async (old) => {
      const host = await replacement(old);
      f.modeld.ready = false;
      return host;
    };
    const result = await runManualReadopt(f.input);
    expect(result).toMatchObject({ reconcile: "recovery-required", reason: "modeld_not_ready", signaled: true, injected: false });
    expect(result.attemptKey).toContain(`:${f.host.pid}:${f.host.start}:`);
    expect(f.tree.signals).toEqual([expect.objectContaining({ pid: f.host.pid, signal: "SIGTERM" })]);
    expect(f.counts.launches).toBe(0);
    expect(result.committedAttestation).toBeUndefined();
    expect(await readAttestation(f.ephemeralRoot)).toBeNull(); // never resurrect the old attestation
    f.modeld.ready = true;
    await expectNoRetry(f);
  });

  test.each(["throw-before-write", "no-write", "wrong-profile", "wrong-pid", "partial", "throw-after-write", "journal-failure", "coordinator-failure"])(
    "persist %s gives a truthful bounded receipt and fences uncertainty", async (fault) => {
      const f = await receiptFixture("route", true);
      f.input.adopt!.persistAttestation = async (record) => {
        if (fault === "throw-before-write") throw new Error("fixture-storage-failure");
        if (fault === "no-write") return;
        if (fault === "wrong-profile") return writeAttestation(f.ephemeralRoot, { ...record, compile: expectedCompileReceipt(nextProfile) });
        if (fault === "wrong-pid") return writeAttestation(f.ephemeralRoot, { ...record, pid: f.host.pid });
        if (fault === "partial") return writeFile(attestationPath(f.ephemeralRoot), '{"partial":');
        await writeAttestation(f.ephemeralRoot, record);
        if (fault === "throw-after-write") throw new Error("fixture-post-write-failure");
        if (fault === "journal-failure") {
          // Only this fixture's own file is displaced. No pre-existing tree is modified.
          await rename(adoptOpStatePath(f.ephemeralRoot), join(f.root, "prior-journal.json"));
          await mkdir(adoptOpStatePath(f.ephemeralRoot));
        }
        if (fault === "coordinator-failure") {
          await rename(coordinatorStatePath(f.root), join(f.root, "prior-coordinator.json"));
          await mkdir(coordinatorStatePath(f.root));
        }
      };
      const result = await runManualReadopt(f.input);
      expect(result.reconcile, JSON.stringify(result)).toBe("recovery-required");
      expect(result.signaled).toBe(true);
      expect(result.attemptKey).toContain(`:${f.host.pid}:${f.host.start}:`);
      if (["throw-after-write", "journal-failure", "coordinator-failure"].includes(fault)) {
        const record = await readAttestation(f.ephemeralRoot);
        expect(record).not.toBeNull();
        expect(result.committedAttestation).toEqual(record!);
        expect(result.committedAttestation?.pid).not.toBe(f.host.pid);
        expect(result.committedAttestation?.compile).toEqual(f.launch.marker?.compile);
      } else expect(result.committedAttestation).toBeUndefined();
      expect(f.counts.launches).toBe(1);
      await expectNoRetry(f);
    },
  );

  test("deactivation persistence throws after TERM: no forged old attestation or lost signal", async () => {
    const f = await receiptFixture("route", true);
    const replacement = f.input.waitReplacement!;
    f.input.waitReplacement = async (old) => {
      const born = await replacement(old);
      await rename(attestationPath(f.ephemeralRoot), join(f.root, "old-fixture-attestation.json"));
      await mkdir(attestationPath(f.ephemeralRoot));
      return born;
    };
    expect(await runManualReadopt(f.input)).toMatchObject({
      reconcile: "recovery-required", reason: "deactivate-persistence-failed", signaled: true, injected: false,
    });
    expect(f.counts.launches).toBe(0);
    await expectNoRetry(f);
  });
});
