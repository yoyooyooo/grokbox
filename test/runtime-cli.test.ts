import { describe, expect, spyOn, test } from "bun:test";
import * as dns from "node:dns";
import { lstat, mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveH3AdoptAdapter } from "../packages/cli/src/commands/runtime.ts";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import * as modeldModule from "../packages/box-runtime/src/modeld.ts";
import * as coordinatorModule from "../packages/box-runtime/src/coordinator.ts";
import { receiptFixture } from "../packages/box-runtime/test/receipt-fixture.ts";
import { snapshotTree } from "../packages/box-runtime/test/observation-fixture.ts";
import { liveStatusAdapter } from "../packages/box-runtime/src/observe.ts";
import { desiredPath } from "../packages/box-runtime/src/paths.ts";
import { snapshotContracts } from "../packages/box-runtime/src/contracts.ts";
import { SHA, SOURCE } from "../packages/box-runtime/test/admission-fixture.ts";
import { sha256Bytes } from "../packages/box-runtime/src/hash.ts";
import { applyPatchProfile } from "../packages/box-runtime/src/transform.ts";
import { modeldSocketPath, probeStubModeld, STUB_ECHO_MODEL_ID } from "../packages/box-runtime/src/modeld-ipc.ts";
import { LIVE_SHAPED_HOST } from "../packages/box-runtime/test/live-shaped-host.ts";
import { captureCli, parseJson } from "./helpers.ts";

const SAMPLE_MODELS = {
  version: 1,
  models: {
    "acme/fast": {
      provider: "acme",
      model: "fast",
      endpoint: "https://api.acme.test/v1",
      apiKeyRef: "env:ACME_KEY",
      capabilities: { vision: false, tools: true },
      dataTypes: ["text", "tools"],
    },
  },
  assignments: { main: null, agents: {} },
};

async function withRoot() {
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-box-runtime-"));
  await writeFile(join(boxRuntimeRoot, "models.json"), `${JSON.stringify(SAMPLE_MODELS, null, 2)}\n`);
  return boxRuntimeRoot;
}

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

function stubLiveAdoptPorts() {
  const processes = {
    inspect: () => null,
    list: () => [],
    signal: () => ({ ok: false as const, reason: "not-found" as const }),
  };
  return {
    processes,
    classify: () => null,
    waitHostGone: async () => true,
    supervisorRelaunch: async () => null,
    waitReady: async () => null,
    applyLaunchEnv: async () => undefined,
    hasGrokboxPreload: () => false,
    spawnTempSupervisor: async () => null,
    waitNewHost: async () => null,
    readGatewayPid: () => null,
    guardianDeadlineMs: 1,
    waitBudgetMs: 1,
    adoptProveMs: 1,
  };
}

function spyLiveAdoptFactory() {
  return spyOn(liveH3AdoptAdapter, "createLiveH3AdoptPorts").mockImplementation(() => stubLiveAdoptPorts());
}

function spyStatusReaders(runRoot: string) {
  const spies = [
    spyOn(liveStatusAdapter, "runRoot").mockReturnValue(runRoot),
    spyOn(liveStatusAdapter, "processes").mockImplementation(() => stubLiveAdoptPorts().processes),
    spyOn(liveStatusAdapter, "envHas").mockReturnValue(false),
    spyOn(liveStatusAdapter, "diskSha").mockResolvedValue({ state: "unavailable" }),
    spyOn(liveStatusAdapter, "gatewayPid").mockResolvedValue({ state: "missing" }),
    spyOn(liveStatusAdapter, "modeldReady").mockResolvedValue(false),
  ];
  return () => { for (const spy of spies) spy.mockRestore(); };
}

function isUnixSocketConnect(args: unknown[]): boolean {
  const flat = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
  for (const arg of flat) {
    if (typeof arg === "string" && (arg.startsWith("/") || arg.endsWith(".sock"))) return true;
    if (arg && typeof arg === "object" && "path" in arg) {
      const path = (arg as { path?: unknown }).path;
      if (typeof path === "string" && path.length > 0) return true;
    }
  }
  return false;
}

function installNetworkTraps(counts: { fetch: number; dns: number; tcp: number }): () => void {
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup.bind(dns);
  const originalResolve = dns.resolve.bind(dns);
  const originalResolve4 = dns.resolve4.bind(dns);
  const originalResolve6 = dns.resolve6.bind(dns);
  const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);
  const originalConnect = net.Socket.prototype.connect;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    counts.fetch += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  const spies = [
    spyOn(dns, "lookup").mockImplementation(((...args: Parameters<typeof dns.lookup>) => {
      counts.dns += 1;
      return originalLookup(...args);
    }) as typeof dns.lookup),
    spyOn(dns, "resolve").mockImplementation(((...args: Parameters<typeof dns.resolve>) => {
      counts.dns += 1;
      return originalResolve(...args);
    }) as typeof dns.resolve),
    spyOn(dns, "resolve4").mockImplementation(((...args: Parameters<typeof dns.resolve4>) => {
      counts.dns += 1;
      return originalResolve4(...args);
    }) as typeof dns.resolve4),
    spyOn(dns, "resolve6").mockImplementation(((...args: Parameters<typeof dns.resolve6>) => {
      counts.dns += 1;
      return originalResolve6(...args);
    }) as typeof dns.resolve6),
    spyOn(dns.promises, "lookup").mockImplementation((async (...args: Parameters<typeof dns.promises.lookup>) => {
      counts.dns += 1;
      return await originalPromisesLookup(...args);
    }) as typeof dns.promises.lookup),
    spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: never[]) {
      if (!isUnixSocketConnect(args)) counts.tcp += 1;
      return originalConnect.apply(this, args as never);
    }),
  ];
  return () => {
    globalThis.fetch = originalFetch;
    for (const spy of spies) spy.mockRestore();
  };
}

describe("box-local runtime CLI", () => {
  test("registry has runtime leaves and no inject/heal/kill", () => {
    const keys = LEAF_COMMANDS.map((leaf) => leaf.path.join(" "));
    for (const key of [
      "runtime status",
      "runtime activate",
      "runtime deactivate",
      "runtime log",
      "runtime contracts",
      "runtime models check",
      "runtime models list",
      "runtime models use",
      "runtime models reset",
      "runtime profile write",
      "runtime re-adopt",
      "runtime watchdog run",
      "runtime modeld run",
    ]) {
      expect(keys).toContain(key);
    }
    expect(
      keys.some(
        (key) =>
          key.includes("inject") ||
          key.includes("heal") ||
          key === "runtime kill" ||
          key.split(" ").includes("ctl"),
      ),
    ).toBe(false);
  });

  test("runtime profile write atomically authors protected JSON only from a synthetic Host", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    const liveSpy = spyLiveAdoptFactory();
    const secretSpy = spyOn(modeldModule, "createFileEnvSecretResolver");
    try {
      const wrote = await captureCli(["runtime", "profile", "write", "--from", hostBundle], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
        fetch: (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
          throw new Error("profile authoring must not use network");
        }) as typeof fetch,
      });
      expect(wrote.code, wrote.stderr).toBe(0);
      const body = data(wrote.stdout);
      expect(body).toMatchObject({ process: "profile-write", offline: true, signaled: false, inject: false });
      expect(body.profilePath).toBe(join(boxRuntimeRoot, "profiles", "reviewed.json"));
      expect(body.sourceSha256).toBe(sha256Bytes(Buffer.from(LIVE_SHAPED_HOST)));
      expect(body.diskSha).toBe(body.sourceSha256);
      expect(body).not.toHaveProperty("copyPath");
      const profile = JSON.parse(await readFile(String(body.profilePath), "utf8"));
      expect(profile.profileId).toBe("reviewed-copy");
      const applied = applyPatchProfile(LIVE_SHAPED_HOST, profile);
      expect(applied.ok).toBe(true);
      if (!applied.ok) throw new Error(applied.code);
      expect(body.transformedSourceSha256).toBe(sha256Bytes(Buffer.from(applied.source)));
      expect(body.transformedSourceSha256).not.toBe(body.sourceSha256);
      expect(await readdir(join(boxRuntimeRoot, "profiles"))).toEqual(["reviewed.json"]);
      expect((await lstat(join(boxRuntimeRoot, "profiles"))).mode & 0o777).toBe(0o700);
      expect((await lstat(String(body.profilePath))).mode & 0o777).toBe(0o600);
      expect(await readFile(hostBundle, "utf8")).toBe(LIVE_SHAPED_HOST);
      expect(liveSpy).not.toHaveBeenCalled();
      expect(secretSpy).not.toHaveBeenCalled();
    } finally {
      secretSpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  test("runtime profile write rejects invalid input without replacing the prior good artifact", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-invalid-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    const badBundle = join(boxRuntimeRoot, "bad-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    await writeFile(badBundle, LIVE_SHAPED_HOST + LIVE_SHAPED_HOST);
    const deps = { discoveryPath: "/dev/null", boxRuntimeRoot };
    const good = await captureCli(["runtime", "profile", "write", "--from", hostBundle], deps);
    expect(good.code, good.stderr).toBe(0);
    const profilePath = String(data(good.stdout).profilePath);
    const previous = await readFile(profilePath, "utf8");
    for (const args of [
      [], ["--from", "relative.cjs"], ["--from", "  "],
      ["--from", join(boxRuntimeRoot, "missing.cjs")],
      ["--from", badBundle], ["--from", profilePath],
    ]) {
      const failed = await captureCli(["runtime", "profile", "write", ...args], deps);
      expect(failed.code, failed.stderr).toBe(2);
      expect(failed.stdout).toBe("");
      expect(parseJson(failed.stderr)).toMatchObject({ error: { code: "invalid_usage" } });
      expect(await readFile(profilePath, "utf8")).toBe(previous);
      expect(await readdir(join(boxRuntimeRoot, "profiles"))).toEqual(["reviewed.json"]);
    }
  });

  test("runtime profile write refuses Profile/remote contexts before authoring or live ports", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-local-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    const before = await readdir(boxRuntimeRoot);
    const spy = spyLiveAdoptFactory();
    try {
      const args = ["runtime", "profile", "write", "--from", hostBundle];
      const profiled = await captureCli(["--profile", "default", ...args], { boxRuntimeRoot });
      const remote = await captureCli(args, { boxRuntimeRoot, sshHost: "box.example" });
      for (const refused of [profiled, remote]) {
        expect(refused.code, refused.stderr).toBe(65);
        expect(refused.stdout).toBe("");
        expect(parseJson(refused.stderr)).toMatchObject({ error: { code: "runtime_local_only" } });
      }
      expect(await readdir(boxRuntimeRoot)).toEqual(before);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("--profile and remote transports return runtime_local_only", async () => {
    const profiled = await captureCli(["--profile", "default", "runtime", "status"], {
      discoveryPath: "/dev/null",
    });
    expect(profiled.code).toBe(65);
    expect(profiled.stdout).toBe("");
    expect((parseJson(profiled.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");

    const remote = await captureCli(["runtime", "status"], {
      discoveryPath: "/dev/null",
      sshHost: "box.example",
    });
    expect(remote.code).toBe(65);
    expect((parseJson(remote.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");
  });

  test("deactivate writes desired disabled and does not claim live coverage none", async () => {
    const boxRuntimeRoot = await withRoot();
    const deactivated = await captureCli(["runtime", "deactivate"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(deactivated.code, deactivated.stderr).toBe(0);
    const body = data(deactivated.stdout);
    expect(body.desired).toBe("disabled");
    expect(body.requested).toBe(true);
    expect(body).not.toHaveProperty("coverage");
    expect(JSON.stringify(body)).not.toContain('"coverage":"none"');
  });

  test("status/log/contracts do not repair and status has required fields", async () => {
    const boxRuntimeRoot = await withRoot();
    const restore = spyStatusReaders(join(boxRuntimeRoot, "missing-run"));
    const before = await snapshotTree(boxRuntimeRoot);
    try {
      const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(status.code).toBe(0);
      const body = data(status.stdout);
      expect(body).toMatchObject({ circuit: "unknown", lastHeal: null, driftedSlices: null });
      expect(["none", "window-open", "attested"]).toContain(String(body.coverage));
      expect(body.census).toBeDefined();
      expect((body.window as { affectedInvocations: string }).affectedInvocations).toBe("unknown");
      expect((body.installation as { durableRoot: string }).durableRoot).toBe(boxRuntimeRoot);
      expect((body.installation as { durableRoot: string }).durableRoot).not.toContain("/.grokbox/runtime/");
      const log = await captureCli(["runtime", "log"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(log.code).toBe(0);
      expect(data(log.stdout)).toMatchObject({ state: "missing", events: [] });
      const contracts = await captureCli(["runtime", "contracts"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(contracts.code).toBe(0);
      expect(data(contracts.stdout)).toMatchObject({ state: "missing", head: null });
      expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
    } finally { restore(); }
  });

  test("contracts/log CLI returns existing metadata and projected events without rewriting them", async () => {
    const boxRuntimeRoot = await withRoot();
    const generation = await snapshotContracts({ root: boxRuntimeRoot, source: SOURCE, sourceSha: SHA, observedAt: "2026-01-01T00:00:00.000Z" });
    await mkdir(join(boxRuntimeRoot, "log"));
    await writeFile(join(boxRuntimeRoot, "log", "events.ndjson"), JSON.stringify({ name: "census", at: "2026-01-01T00:00:00.000Z", counts: { host: 1 }, prompt: "fixture-private-body" }) + "\n");
    const before = await snapshotTree(boxRuntimeRoot);
    const contracts = await captureCli(["runtime", "contracts"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(contracts.code).toBe(0);
    expect(data(contracts.stdout)).toMatchObject({ state: "present", head: SHA,
      generations: [{ state: "present", metadata: { sliceHashes: generation.sliceHashes, driftedSlices: [] } }] });
    const log = await captureCli(["runtime", "log"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(log.code).toBe(0);
    expect(data(log.stdout)).toMatchObject({ state: "present", events: [{ name: "census", counts: { host: 1 } }] });
    expect(log.stdout).not.toContain("fixture-private-body");
    expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
  });

  test("status reports invalid configuration without falling back to a disabled success or writing files", async () => {
    const boxRuntimeRoot = await withRoot();
    await mkdir(join(boxRuntimeRoot, "state"));
    await writeFile(desiredPath(boxRuntimeRoot), "{broken");
    await writeFile(join(boxRuntimeRoot, "models.json"), "null");
    const before = await snapshotTree(boxRuntimeRoot);
    const restore = spyStatusReaders(join(boxRuntimeRoot, "missing-run"));
    try {
      const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(status.code).toBe(0);
      expect(data(status.stdout)).toMatchObject({ activation: { desired: null, reconcile: "unknown" }, evidence: { desired: "invalid", models: "invalid" } });
      expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
    } finally { restore(); }
  });

  test("runtime log --follow fails closed rather than returning one successful snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-follow-"));
    const boxRuntimeRoot = join(root, "missing");
    const before = await snapshotTree(root);
    const follow = await captureCli(["runtime", "log", "--follow"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(follow.code).toBe(2);
    expect(follow.stdout).toBe("");
    expect((parseJson(follow.stderr) as { error: { message: string } }).error.message).toContain("not supported");
    expect(await snapshotTree(root)).toEqual(before);
  });

  test("models check labels schema evidence without claiming provider availability", async () => {
    const boxRuntimeRoot = await withRoot();
    const checked = await captureCli(["runtime", "models", "check"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(checked.code).toBe(0);
    expect(data(checked.stdout)).toMatchObject({ ok: true, checked: ["schema"], serviceReadiness: "not_checked" });
  });

  test("models use discloses endpoint and --for vs default", async () => {
    const boxRuntimeRoot = await withRoot();
    const used = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(used.code, used.stderr).toBe(0);
    expect(data(used.stdout)).toMatchObject({
      endpoint: "https://api.acme.test/v1",
      dataTypes: ["text", "tools"],
      takesEffect: "next_user_turn",
      blastRadius: "box_default",
      assignment: "main",
    });

    const forBot = await captureCli(["runtime", "models", "use", "acme/fast", "--for", "agent-tom"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(forBot.code, forBot.stderr).toBe(0);
    expect(data(forBot.stdout)).toMatchObject({
      blastRadius: "single_bot",
      assignment: { agent: "agent-tom" },
    });
  });

  test("models reset is refused while route is desired", async () => {
    const boxRuntimeRoot = await withRoot();
    const use = await captureCli(["runtime", "models", "use", "stub/echo"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(use.code, use.stderr).toBe(0);
    const activate = await captureCli(["runtime", "activate", "--mode", "route"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    const reset = await captureCli(["runtime", "models", "reset"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(reset.code).toBe(2);
    expect((parseJson(reset.stderr) as { error: { code: string } }).error.code).toBe("invalid_usage");
  });

  test("re-adopt without --confirm refuses before mutation", async () => {
    const boxRuntimeRoot = await withRoot();
    const refused = await captureCli(["runtime", "re-adopt"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect((parseJson(refused.stderr) as { error: { code: string; message: string } }).error.code).toBe(
      "invalid_usage",
    );
    expect((parseJson(refused.stderr) as { error: { message: string } }).error.message).toContain("--confirm");
  });

  test("re-adopt receipt preserves half-success while omitting raw process argv", async () => {
    const f = await receiptFixture();
    const done = await coordinatorModule.runManualReadopt(f.input);
    expect(done.reconcile).toBe("converged");
    const committed = done.committedAttestation!;
    // A fixture-only sentinel proves raw process identity never enters CLI output.
    committed.identity = { ...committed.identity, cmdline: ["fixture-private-argv"] };
    const factory = spyLiveAdoptFactory();
    const coordinator = spyOn(coordinatorModule, "runManualReadopt").mockResolvedValue({
      ...done, reconcile: "recovery-required", reason: "coordinator-persistence-failed", committedAttestation: committed,
    });
    try {
      const boxRuntimeRoot = await withRoot();
      const receipt = await captureCli(["runtime", "re-adopt", "--confirm"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(receipt.code).toBe(0); // Existing command acknowledgement contract; reconcile is the outcome.
      expect(data(receipt.stdout)).toMatchObject({
        reconcile: "recovery-required", signaled: true,
        committedAttestation: { pid: committed.pid, start: committed.start, compile: committed.compile },
      });
      expect(receipt.stdout).not.toContain("fixture-private-argv");
      expect(receipt.stdout).not.toContain('"identity"');
    } finally { coordinator.mockRestore(); factory.mockRestore(); }
  });

  test("re-adopt --profile and remote transports return runtime_local_only", async () => {
    const profiled = await captureCli(["--profile", "default", "runtime", "re-adopt", "--confirm"], {
      discoveryPath: "/dev/null",
    });
    expect(profiled.code).toBe(65);
    expect(profiled.stdout).toBe("");
    expect((parseJson(profiled.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");

    const remote = await captureCli(["runtime", "re-adopt", "--confirm"], {
      discoveryPath: "/dev/null",
      sshHost: "box.example",
    });
    expect(remote.code).toBe(65);
    expect((parseJson(remote.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");
  });

  test("activate stays desired-only and watchdog run does not expose inject/ctl", async () => {
    const boxRuntimeRoot = await withRoot();
    const activate = await captureCli(["runtime", "activate", "--mode", "identity"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    expect(data(activate.stdout)).toMatchObject({ desired: "identity", inject: false });

    const watchdog = await captureCli(["runtime", "watchdog", "run"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(watchdog.code, watchdog.stderr).toBe(0);
    const body = data(watchdog.stdout);
    expect(body.process).toBe("watchdog");
    expect(body.inject).toBe(false);
    expect(body.signaled).toBe(false);
    expect(["converged", "pending", "blocked", "recovery-required"]).toContain(String(body.reconcile));
    expect(JSON.stringify(body)).not.toContain("ctl");

    const spy = spyLiveAdoptFactory();
    try {
      const readopt = await captureCli(["runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(readopt.code, readopt.stderr).toBe(0);
      const readoptBody = data(readopt.stdout);
      expect(readoptBody.process).toBe("re-adopt");
      expect(readoptBody.confirmed).toBe(true);
      expect(readoptBody.attempts).toBe(1);
      expect(readoptBody.injected).toBe(false);
      expect(readoptBody.signaled).toBe(false);
      expect(JSON.stringify(data(activate.stdout))).not.toContain("re-adopt");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("live-adapter factory is constructed only by confirmed local re-adopt", async () => {
    const spy = spyLiveAdoptFactory();
    try {
      const boxRuntimeRoot = await withRoot();
      const missing = await captureCli(["runtime", "re-adopt"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(missing.code).toBe(2);
      expect(spy).not.toHaveBeenCalled();

      const profiled = await captureCli(["--profile", "default", "runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
      });
      expect(profiled.code).toBe(65);
      expect(spy).not.toHaveBeenCalled();

      const remote = await captureCli(["runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
        sshHost: "box.example",
      });
      expect(remote.code).toBe(65);
      expect(spy).not.toHaveBeenCalled();

      const activate = await captureCli(["runtime", "activate", "--mode", "identity"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(activate.code, activate.stderr).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      const useStub = await captureCli(["runtime", "models", "use", "stub/echo"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(useStub.code, useStub.stderr).toBe(0);
      const route = await captureCli(["runtime", "activate", "--mode", "route"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(route.code, route.stderr).toBe(0);
      expect(data(route.stdout)).toMatchObject({ desired: "route", inject: false });
      expect(spy).not.toHaveBeenCalled();

      const status = await captureCli(["runtime", "status"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      const watchdog = await captureCli(["runtime", "watchdog", "run"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(watchdog.code, watchdog.stderr).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      const confirmed = await captureCli(["runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(confirmed.code, confirmed.stderr).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(data(confirmed.stdout).injected).toBe(false);
      expect(data(confirmed.stdout).signaled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("models use refuses a non-stub assignment while route is desired", async () => {
    const boxRuntimeRoot = await withRoot();
    const useStub = await captureCli(["runtime", "models", "use", "stub/echo"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(useStub.code, useStub.stderr).toBe(0);
    const activate = await captureCli(["runtime", "activate", "--mode", "route"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    const drifted = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(drifted.code).toBe(2);
    expect((parseJson(drifted.stderr) as { error: { code: string } }).error.code).toBe("invalid_usage");
    const listed = await captureCli(["runtime", "models", "list"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(listed.code, listed.stderr).toBe(0);
    expect((data(listed.stdout).assignments as { main: string }).main).toBe("stub/echo");
  });

  test("activate --mode route refuses a non-stub assignment", async () => {
    const boxRuntimeRoot = await withRoot();
    const use = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(use.code, use.stderr).toBe(0);
    const activate = await captureCli(["runtime", "activate", "--mode", "route"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code).toBe(2);
    expect((parseJson(activate.stderr) as { error: { code: string } }).error.code).toBe("invalid_usage");
  });

  test("modeld run under temp root: start → probe → abort cleans socket with hard-off", async () => {
    const boxRuntimeRoot = await withRoot();
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-modeld-cli-"));
    const ac = new AbortController();
    const counts = { fetch: 0, dns: 0, tcp: 0 };
    const restore = installNetworkTraps(counts);
    const secretSpy = spyOn(modeldModule, "createFileEnvSecretResolver");
    try {
      const running = captureCli(["runtime", "modeld", "run"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
        env: { GROKBOX_RUN_ROOT: runRoot },
        signal: ac.signal,
      });

      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (await probeStubModeld(runRoot)) {
          ready = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(ready).toBe(true);

      ac.abort();
      const result = await running;
      expect(result.code, result.stderr).toBe(0);
      expect(data(result.stdout)).toMatchObject({
        process: "modeld",
        state: "running",
        provider: false,
        model: STUB_ECHO_MODEL_ID,
      });
      expect(await probeStubModeld(runRoot)).toBe(false);
      await expect(lstat(modeldSocketPath(runRoot))).rejects.toMatchObject({ code: "ENOENT" });
      expect(counts.fetch).toBe(0);
      expect(counts.dns).toBe(0);
      expect(counts.tcp).toBe(0);
      expect(secretSpy).not.toHaveBeenCalled();
    } finally {
      if (!ac.signal.aborted) ac.abort();
      secretSpy.mockRestore();
      restore();
    }
  });

  test("literal secrets are rejected", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-box-runtime-"));
    await mkdir(boxRuntimeRoot, { recursive: true });
    await writeFile(
      join(boxRuntimeRoot, "models.json"),
      `${JSON.stringify({
        version: 1,
        models: {
          "acme/fast": {
            provider: "acme",
            model: "fast",
            endpoint: "https://api.acme.test/v1",
            apiKeyRef: "sk-literal",
          },
        },
        assignments: { main: null, agents: {} },
      })}\n`,
    );
    const check = await captureCli(["runtime", "models", "check"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(check.code).toBe(31);
    expect((parseJson(check.stderr) as { error: { code: string } }).error.code).toBe("credential_invalid");
  });
});
