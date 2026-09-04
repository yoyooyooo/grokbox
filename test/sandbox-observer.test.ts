import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeLeaseCoverage,
  classifySshProbe,
  projectSandboxFailure,
} from "../scripts/sandbox-observer-helpers.mjs";

const observer = join(import.meta.dir, "..", "scripts", "observe-sandbox.mjs");
const node = Bun.which("node") ?? process.execPath;

async function runObserver(
  exitEarly: boolean,
  durationMs = "500",
  ignoreTerm = false,
): Promise<{ code: number; stdout: string; artifact: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), "grokbox-observer-test-"));
  const evidenceDir = join(root, "evidence");
  const fake = join(root, "fake-grokbox.mjs");
  await writeFile(fake, `#!/usr/bin/env node
console.log(JSON.stringify({ok:true,data:{status:"healthy",tickCount:1,lastFailure:null,descriptorRotated:false}}));
${exitEarly
  ? "process.exit(0);"
  : ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : "process.on('SIGTERM', () => { console.log(JSON.stringify({ok:true,data:{status:'stopped',tickCount:1,lastFailure:null,descriptorRotated:false}})); process.exit(0); }); setInterval(() => {}, 1000);"}
`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const child = Bun.spawn([node, observer], {
    env: {
      ...process.env,
      GROKBOX_BIN: fake,
      GROKBOX_SANDBOX_PHASE: "lease",
      GROKBOX_SANDBOX_PROFILE: "test",
      GROKBOX_SANDBOX_EVIDENCE_DIR: evidenceDir,
      GROKBOX_SANDBOX_DURATION_MS: durationMs,
      GROKBOX_SANDBOX_INTERVAL_MS: "1000",
      GROKBOX_SANDBOX_OBSERVE_EVERY_MS: "1000",
      GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED: "1",
      GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED: "1",
      GROKBOX_SANDBOX_ALLOW_SHORT: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const files = await readdir(evidenceDir);
  expect(files).toHaveLength(1);
  const artifact = JSON.parse(await readFile(join(evidenceDir, files[0]!), "utf8"));
  return { code, stdout, artifact };
}

async function markerCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).length;
  } catch {
    return 0;
  }
}

async function runReachabilityPhase(
  phase: "reachability" | "stop-observe",
  sshMode: "reachable" | "timeout" | "auth",
  controlState = "hibernated",
): Promise<{
  code: number;
  artifact: Record<string, any>;
  checkpoint?: Record<string, any>;
  checkpointMode?: number;
  evidenceDirMode: number;
  productCalls: number;
  tailnetCalls: number;
  sshCalls: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "grokbox-observer-reachability-test-"));
  const evidenceDir = join(root, "evidence");
  const binDir = join(root, "bin");
  const productMarker = join(root, "product.calls");
  const tailnetMarker = join(root, "tailnet.calls");
  const sshMarker = join(root, "ssh.calls");
  await mkdir(binDir, { recursive: true });
  const fakeProduct = join(binDir, "grokbox");
  const fakeTailscale = join(binDir, "tailscale");
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeProduct, `#!/bin/sh\nprintf x >> ${JSON.stringify(productMarker)}\nprintf '%s\\n' '${JSON.stringify({ ok: true, data: { state: controlState } })}'\n`, { mode: 0o700 });
  await writeFile(fakeTailscale, `#!/bin/sh\nprintf x >> ${JSON.stringify(tailnetMarker)}\nexit 0\n`, { mode: 0o700 });
  const sshOutcome = sshMode === "reachable"
    ? "exit 0"
    : sshMode === "timeout"
      ? "echo 'ssh: connect to host target port 22: Operation timed out' >&2\nexit 255"
      : "echo 'Permission denied (publickey)' >&2\nexit 255";
  await writeFile(fakeSsh, `#!/bin/sh\nprintf x >> ${JSON.stringify(sshMarker)}\n${sshOutcome}\n`, { mode: 0o700 });
  await Promise.all([chmod(fakeProduct, 0o700), chmod(fakeTailscale, 0o700), chmod(fakeSsh, 0o700)]);
  const child = Bun.spawn([node, observer], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GROKBOX_BIN: fakeProduct,
      GROKBOX_SANDBOX_PHASE: phase,
      ...(phase === "stop-observe" ? {
        GROKBOX_SANDBOX_PROFILE: "test",
        GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED: "1",
      } : {
        GROKBOX_SANDBOX_EXPECT_SSH: "reachable",
      }),
      GROKBOX_SANDBOX_EVIDENCE_DIR: evidenceDir,
      GROKBOX_SANDBOX_DURATION_MS: "50",
      GROKBOX_SANDBOX_OBSERVE_EVERY_MS: "1000",
      GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED: "1",
      GROKBOX_SANDBOX_PEER: "private-peer",
      GROKBOX_SANDBOX_SSH_TARGET: "private-ssh-target",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const files = await readdir(evidenceDir);
  const artifactName = files.find((file) => file.endsWith(".json") && !file.includes(".checkpoint-"));
  if (!artifactName) throw new Error("Missing final observer artifact.");
  const checkpointName = files.find((file) => file.includes(".checkpoint-") && file.endsWith(".json"));
  return {
    code,
    artifact: JSON.parse(await readFile(join(evidenceDir, artifactName), "utf8")),
    ...(checkpointName ? {
      checkpoint: JSON.parse(await readFile(join(evidenceDir, checkpointName), "utf8")),
      checkpointMode: (await stat(join(evidenceDir, checkpointName))).mode & 0o777,
    } : {}),
    evidenceDirMode: (await stat(evidenceDir)).mode & 0o777,
    productCalls: await markerCount(productMarker),
    tailnetCalls: await markerCount(tailnetMarker),
    sshCalls: await markerCount(sshMarker),
  };
}

async function runWakePhase(doctorHealthy: boolean): Promise<{ code: number; artifact: Record<string, any> }> {
  const root = await mkdtemp(join(tmpdir(), "grokbox-observer-wake-test-"));
  const evidenceDir = join(root, "evidence");
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeProduct = join(binDir, "grokbox");
  const fakeTailscale = join(binDir, "tailscale");
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeProduct, `#!/bin/sh
case "$*" in
  *" doctor") printf '%s\\n' '{"ok":true,"data":{"ok":${doctorHealthy}}}' ;;
  *) printf '%s\\n' '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o700 });
  await writeFile(fakeTailscale, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(fakeSsh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await Promise.all([chmod(fakeProduct, 0o700), chmod(fakeTailscale, 0o700), chmod(fakeSsh, 0o700)]);
  const child = Bun.spawn([node, observer], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GROKBOX_BIN: fakeProduct,
      GROKBOX_SANDBOX_PHASE: "wake-recover",
      GROKBOX_SANDBOX_PROFILE: "test",
      GROKBOX_SANDBOX_EVIDENCE_DIR: evidenceDir,
      GROKBOX_SANDBOX_DURATION_MS: "2000",
      GROKBOX_SANDBOX_OBSERVE_EVERY_MS: "5000",
      GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED: "1",
      GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED: "1",
      GROKBOX_SANDBOX_PEER: "private-peer",
      GROKBOX_SANDBOX_SSH_TARGET: "private-ssh-target",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const files = await readdir(evidenceDir);
  return {
    code,
    artifact: JSON.parse(await readFile(join(evidenceDir, files[0]!), "utf8")),
  };
}

describe("external Sandbox observer", () => {
  test("lease analysis rejects delayed starts, duplicate ticks, and arbitrary failure text", () => {
    expect(analyzeLeaseCoverage([
      { status: "healthy", tickCount: 1, observedAtMs: 160 },
      { status: "healthy", tickCount: 2, observedAtMs: 180 },
    ], 0, 200, 50)).toMatchObject({ continuousCoverage: false, sequenceValid: true });
    expect(analyzeLeaseCoverage([
      { status: "healthy", tickCount: 1, observedAtMs: 10 },
      { status: "healthy", tickCount: 1, observedAtMs: 20 },
    ], 0, 30, 50)).toMatchObject({ observedTicks: 1, continuousCoverage: false, sequenceValid: false });
    expect(analyzeLeaseCoverage([
      { status: "healthy", tickCount: 1, observedAtMs: 10 },
      { status: "healthy", tickCount: 2, observedAtMs: 40 },
    ], 0, 50, 50)).toMatchObject({ observedTicks: 2, healthyTicks: 2, continuousCoverage: true });
    expect(projectSandboxFailure("provider_unavailable")).toBe("provider_unavailable");
    expect(projectSandboxFailure("secret provider body")).toBe("unknown");
    expect(classifySshProbe({ ok: false, stderr: "Permission denied (publickey)" })).toBe("inconclusive");
    expect(classifySshProbe({ ok: false, stderr: "Operation timed out" })).toBe("network-nonresponse");
  });

  test("wake recovery requires explicit recover plus SSH and doctor target health", async () => {
    const unhealthy = await runWakePhase(false);
    expect(unhealthy.code).toBe(1);
    expect(unhealthy.artifact).toMatchObject({
      outcome: "failed",
      observations: [
        { kind: "wake", ok: true },
        { kind: "recover", ok: true },
        { kind: "recovery", sshReachable: true, daemonReachable: true, doctorHealthy: false },
      ],
    });

    const healthy = await runWakePhase(true);
    expect(healthy.code).toBe(0);
    expect(healthy.artifact).toMatchObject({
      outcome: "passed",
      observations: [
        { kind: "wake", ok: true },
        { kind: "recover", ok: true },
        { kind: "recovery", tailnetReachable: true, sshReachable: true, doctorHealthy: true },
      ],
    });
  });

  test("reachability phase proves external Tailscale and strict SSH without a product Profile", async () => {
    const result = await runReachabilityPhase("reachability", "reachable");
    expect(result.code).toBe(0);
    expect(result.artifact).toMatchObject({
      version: 3,
      phase: "reachability",
      outcome: "passed",
      declarations: { appClosed: null, externalRunner: true, modelTurnKeeperCalls: 0 },
      policy: { expectedSsh: "reachable", observedReachabilitySamples: 1 },
      observations: [{ kind: "reachability", tailnetReachable: true, sshReachable: true, sshStatus: "reachable" }],
    });
    expect(JSON.stringify(result.artifact)).not.toContain("private-peer");
    expect(JSON.stringify(result.artifact)).not.toContain("private-ssh-target");
  });

  test("stop observation remains passive until the control plane reports a freeze candidate", async () => {
    const running = await runReachabilityPhase("stop-observe", "reachable", "running");
    expect(running.code).toBe(1);
    expect(running.productCalls).toBe(1);
    expect(running.tailnetCalls).toBe(0);
    expect(running.sshCalls).toBe(0);
    expect(running.evidenceDirMode).toBe(0o700);
    expect(running.checkpointMode).toBe(0o600);
    expect(running.checkpoint).toMatchObject({
      version: 3,
      phase: "stop-observe",
      outcome: "running",
      policy: {
        passiveUntilFreezeCandidate: true,
        checkpointStrategy: "immutable-per-sample",
      },
      sequence: 1,
      observation: { kind: "stop", state: "running" },
    });
    expect(running.checkpoint?.observation).not.toHaveProperty("sshStatus");
    expect(JSON.stringify(running.checkpoint)).not.toContain("private-peer");
    expect(JSON.stringify(running.checkpoint)).not.toContain("private-ssh-target");
  });

  test("stop observation confirms a freeze candidate with external reachability", async () => {
    const reachable = await runReachabilityPhase("stop-observe", "reachable");
    expect(reachable.productCalls).toBe(1);
    expect(reachable.tailnetCalls).toBe(1);
    expect(reachable.sshCalls).toBe(1);
    expect(reachable.code).toBe(1);
    expect(reachable.artifact).toMatchObject({
      phase: "stop-observe",
      outcome: "failed",
      observations: [{ state: "hibernated", sshReachable: true }],
    });

    const authFailure = await runReachabilityPhase("stop-observe", "auth");
    expect(authFailure.productCalls).toBe(1);
    expect(authFailure.tailnetCalls).toBe(1);
    expect(authFailure.sshCalls).toBe(1);
    expect(authFailure.code).toBe(1);
    expect(authFailure.artifact).toMatchObject({
      outcome: "failed",
      observations: [{ state: "hibernated", sshStatus: "inconclusive" }],
    });

    const unreachable = await runReachabilityPhase("stop-observe", "timeout");
    expect(unreachable.code).toBe(0);
    expect(unreachable.checkpointMode).toBe(0o600);
    expect(unreachable.artifact).toMatchObject({
      phase: "stop-observe",
      outcome: "passed",
      observations: [{ state: "hibernated", sshReachable: false, sshStatus: "network-nonresponse" }],
    });
  });
  test("lease phase requires deadline coverage and writes bounded redacted evidence", async () => {
    const result = await runObserver(false);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(result.artifact).toMatchObject({
      phase: "lease",
      outcome: "passed",
      declarations: { appClosed: true, externalRunner: true, modelTurnKeeperCalls: 0 },
      policy: { expectedMinimumTicks: 1, observedTicks: 1, healthyTicks: 1, tickSequenceValid: true },
      observations: [
        { kind: "keeper", status: "healthy", tickCount: 1 },
        { kind: "keeper", status: "stopped", tickCount: 1 },
      ],
    });
    expect(JSON.stringify(result.artifact)).not.toContain("test");
  });

  test("lease phase fails when the keeper stays alive without enough tick coverage", async () => {
    const result = await runObserver(false, "1200");
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      phase: "lease",
      outcome: "failed",
      policy: { expectedMinimumTicks: 2, observedTicks: 1 },
    });
  });

  test("lease phase escalates an ignored SIGTERM and still persists failed evidence", async () => {
    const result = await runObserver(false, "500", true);
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      outcome: "failed",
      policy: { terminationEscalated: true, forcedSettlement: false },
    });
  }, 10_000);

  test("lease phase fails when the keeper exits before the requested deadline", async () => {
    const result = await runObserver(true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(result.artifact).toMatchObject({ phase: "lease", outcome: "failed" });
  });
});
