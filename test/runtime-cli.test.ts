import { describe, expect, spyOn, test } from "bun:test";
import * as dns from "node:dns";
import { lstat, mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveH3AdoptAdapter } from "../packages/box-runtime/src/internal/process/live-readopt.ts";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import * as credentials from "../packages/box-runtime/src/internal/io/credentials.node.ts";
import * as coordinatorModule from "../packages/box-runtime/src/internal/roots/controller.runtime.ts";
import { receiptFixture } from "../packages/box-runtime/test/receipt-fixture.ts";
import { snapshotTree } from "../packages/box-runtime/test/observation-fixture.ts";
import { liveStatusAdapter } from "../packages/box-runtime/src/internal/io/observe.ts";
import { desiredPath } from "../packages/box-runtime/src/internal/io/paths.ts";
import { appendHostJournal } from "../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { snapshotContracts } from "../packages/box-runtime/src/internal/io/contracts.ts";
import { SHA, SOURCE } from "../packages/box-runtime/test/admission-fixture.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { applyPatchProfile } from "../packages/box-runtime/src/internal/host/profile.ts";
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
      "runtime start",
      "runtime activate",
      "runtime deactivate",
      "runtime log",
      "runtime contracts",
      "runtime models check",
      "runtime models list",
      "runtime models use",
      "runtime models reset",
      "runtime profile analyze",
      "runtime profile observe",
      "runtime profile propose",
      "runtime profile prune",
      "runtime profile replay",
      "runtime profile status",
      "runtime profile watch",
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

        test("runtime profile write atomically authors protected JSON from a retained SHA", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    const liveSpy = spyLiveAdoptFactory();
    const secretSpy = spyOn(credentials, "materializeApiKeyRef");
    const deps = {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
      fetch: (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        throw new Error("profile authoring must not use network");
      }) as typeof fetch,
    };
    try {
      const observed = await captureCli(["runtime", "profile", "observe", "--from", hostBundle], deps);
      expect(observed.code, observed.stderr).toBe(0);
      const sha = String(data(observed.stdout).observedSha);
      const wrote = await captureCli(["runtime", "profile", "write", "--sha", sha], deps);
      expect(wrote.code, wrote.stderr).toBe(0);
      const body = data(wrote.stdout);
      expect(body).toMatchObject({ process: "profile-write", offline: true, signaled: false, inject: false });
      expect(body.profilePath).toBe(join(boxRuntimeRoot, "profiles", "reviewed.json"));
      expect(body.sourceSha256).toBe(sha256Bytes(Buffer.from(LIVE_SHAPED_HOST)));
      expect(body.diskSha).toBe(body.sourceSha256);
      expect(body.unretained_source).toBeUndefined();
      expect(body.envelope).toMatchObject({ bootstrap: true, baselineSourceSha: null, rejectingIds: [] });
      expect(body).not.toHaveProperty("copyPath");
      const profile = JSON.parse(await readFile(String(body.profilePath), "utf8"));
      expect(profile.profileId).toBe("reviewed-copy-envelope");
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
    const observed = await captureCli(["runtime", "profile", "observe", "--from", hostBundle], deps);
    expect(observed.code, observed.stderr).toBe(0);
    const sha = String(data(observed.stdout).observedSha);
    const good = await captureCli(["runtime", "profile", "write", "--sha", sha], deps);
    expect(good.code, good.stderr).toBe(0);
    const profilePath = String(data(good.stdout).profilePath);
    const previous = await readFile(profilePath, "utf8");
    for (const args of [
      [], ["--from", "relative.cjs"], ["--from", "  "],
      ["--from", join(boxRuntimeRoot, "missing.cjs")],
      ["--from", badBundle], ["--from", profilePath],
      ["--from", hostBundle],
      ["--sha", "zzzz"],
      ["--sha", sha, "--from", hostBundle],
      ["--from", badBundle, "--allow-unretained", "--confirm"],
    ]) {
      const failed = await captureCli(["runtime", "profile", "write", ...args], deps);
      expect(failed.code, failed.stderr).toBe(2);
      expect(failed.stdout).toBe("");
      const body = parseJson(failed.stderr) as { error: { code: string; next?: string; message: string } };
      expect(body).toMatchObject({ error: { code: "invalid_usage" } });
      expect(body.error.message).not.toContain("profile write --from /home/box/sand-host/host-main.cjs");
      expect(body.error.next).not.toBe("grokbox runtime profile write --from /home/box/sand-host/host-main.cjs");
      expect(await readFile(profilePath, "utf8")).toBe(previous);
      expect(await readdir(join(boxRuntimeRoot, "profiles"))).toEqual(["reviewed.json"]);
    }
    const backfill = await captureCli(["runtime", "profile", "observe", "--from", hostBundle], deps);
    expect(backfill.code, backfill.stderr).toBe(0);
    const escaped = await captureCli([
      "runtime", "profile", "write", "--from", hostBundle, "--allow-unretained", "--confirm",
    ], deps);
    expect(escaped.code, escaped.stderr).toBe(0);
    expect(data(escaped.stdout).unretained_source).toBe(true);
  });

  test("runtime profile write --from without confirm nexts to observe, not live write", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-unretained-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    const failed = await captureCli(["runtime", "profile", "write", "--from", hostBundle], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(failed.code).toBe(2);
    expect(parseJson(failed.stderr)).toMatchObject({
      error: {
        code: "invalid_usage",
        next: `grokbox runtime profile observe --from ${hostBundle}`,
      },
    });
  });

  test("runtime profile write refuses Profile/remote contexts before authoring or live ports", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-profile-cli-local-"));
    const hostBundle = join(boxRuntimeRoot, "synthetic-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);
    const before = await readdir(boxRuntimeRoot);
    const spy = spyLiveAdoptFactory();
    try {
      const args = ["runtime", "profile", "write", "--from", hostBundle, "--allow-unretained", "--confirm"];
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

  test("re-adopt after deactivate sets route and does not refuse desired-disabled", async () => {
    const factory = spyLiveAdoptFactory();
    try {
      const boxRuntimeRoot = await withRoot();
      const deactivated = await captureCli(["runtime", "deactivate"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(deactivated.code, deactivated.stderr).toBe(0);
      const receipt = await captureCli(["runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(receipt.code, receipt.stderr).toBe(0);
      expect(data(receipt.stdout).reason).not.toBe("desired-disabled");
      expect(JSON.parse(await readFile(desiredPath(boxRuntimeRoot), "utf8")).mode).toBe("route");
      expect(factory).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });

  test("status/log/contracts do not repair and status has required fields", async () => {
    const boxRuntimeRoot = await withRoot();
    const restore = spyStatusReaders(join(boxRuntimeRoot, "missing-run"));
    const before = await snapshotTree(boxRuntimeRoot);
    try {
      const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(status.code).toBe(0);
      const body = data(status.stdout);
      expect(body.schemaVersion).toBe(1);
      expect(body).not.toHaveProperty("watchdog");
      expect(JSON.stringify(body)).not.toContain("degraded");
      expect(Object.keys(body.facets as object).sort()).toEqual([
        "bridge", "controller", "hostDelivery", "modeld", "mutation", "recovery",
      ]);
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
      const body = data(status.stdout);
      expect(body.schemaVersion).toBe(1);
      expect((body.facets as { bridge: { value: { desired: unknown }; gap: string } }).bridge.value.desired).toBeNull();
      expect((body.facets as { bridge: { gap: string } }).bridge.gap).toBe("invalid");
      expect(body).not.toHaveProperty("watchdog");
      expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
    } finally { restore(); }
  });

  test("status Host terminal round-trip and unsafe circuit reasons stay off stdout/stderr", async () => {
    const boxRuntimeRoot = await withRoot();
    const runRoot = join(boxRuntimeRoot, "run");
    const restore = spyStatusReaders(runRoot);
    const secret = "sk-live-SENTINEL_SECRET";
    const prompt = "SENTINEL_PROMPT";
    const errorBody = "SENTINEL_ERROR_BODY";
    try {
      expect(await appendHostJournal(runRoot, {
        name: "host_normalized_terminal",
        at: "2026-01-01T00:00:00.000Z",
        hostId: "host-1",
        agentId: "agent-tom",
        turnId: "turn-1",
        stepId: "step-1",
        serviceEpoch: "epoch-1",
        binding: "bind-1",
        attempt: "1",
        invocationId: "inv-must-not-become-attempt",
        authorization: secret,
      })).toBe("written");
      await mkdir(join(boxRuntimeRoot, "state"), { recursive: true });
      await writeFile(join(boxRuntimeRoot, "state", "coordinator.json"), JSON.stringify({
        version: 1, circuit: "open", mutationCount: 1, attemptedKeys: ["k"], circuitReason: secret,
      }));
      const before = await snapshotTree(boxRuntimeRoot);
      const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(status.code).toBe(0);
      const body = data(status.stdout);
      const delivery = (body.facets as { hostDelivery: { gap: unknown; value: { kind: string; correlated: boolean; tuple: Record<string, string> } } }).hostDelivery;
      expect(delivery.gap).toBeNull();
      expect(delivery.value.kind).toBe("host_terminal");
      expect(delivery.value.correlated).toBe(true);
      expect(delivery.value.tuple).toEqual({
        hostId: "host-1", agentId: "agent-tom", turnId: "turn-1", stepId: "step-1",
        serviceEpoch: "epoch-1", binding: "bind-1", attempt: "1",
      });
      expect((body.circuit as { value: { state: string; reason: unknown } }).value.state).toBe("open");
      expect((body.circuit as { value: { reason: unknown } }).value.reason).toBeNull();
      expect(status.stdout).not.toContain(secret);
      expect(status.stdout).not.toContain(prompt);
      expect(status.stdout).not.toContain(errorBody);
      expect(status.stderr).not.toContain(secret);
      expect(status.stdout).not.toContain("inv-must-not-become-attempt");
      expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);

      expect(await appendHostJournal(runRoot, {
        name: "host_normalized_terminal",
        at: "2026-01-01T00:00:00.000Z",
        hostId: "host-1",
        agentId: secret,
        turnId: "turn-1",
        stepId: "step-1",
        serviceEpoch: "epoch-1",
        binding: "bind-1",
        attempt: "1",
      })).toBe("unprojected");
      const rejected = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(rejected.code).toBe(0);
      expect(rejected.stdout).not.toContain(secret);
      expect(rejected.stderr).not.toContain(secret);
      const rejectedDelivery = (data(rejected.stdout).facets as { hostDelivery: { value: { tuple: Record<string, string> } } }).hostDelivery;
      expect(JSON.stringify(rejectedDelivery)).not.toContain(secret);
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

  test("default models use discloses endpoint; per-Bot use requires a scoped ownership reader", async () => {
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

    const forBot = await captureCli(["runtime", "models", "use", "acme/fast", "--for", "11111111-1111-4111-8111-111111111111"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(forBot.code).not.toBe(0);
    expect(forBot.stdout).toBe("");
    expect(parseJson(forBot.stderr)).toMatchObject({ error: { code: "runtime_ownership_unavailable" } });
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

  test("confirmed re-adopt runs the controller program with zero live mutation", async () => {
    const factory = spyLiveAdoptFactory();
    const coordinator = spyOn(coordinatorModule, "runManualReadopt");
    try {
      const boxRuntimeRoot = await withRoot();
      const receipt = await captureCli(["runtime", "re-adopt", "--confirm"], { discoveryPath: "/dev/null", boxRuntimeRoot });
      expect(receipt.code, receipt.stderr).toBe(0);
      expect(data(receipt.stdout)).toMatchObject({ outcome: "refused", signaled: false, spawned: false, guardian: false });
      expect(factory).not.toHaveBeenCalled();
      expect(coordinator).not.toHaveBeenCalled();
    } finally {
      coordinator.mockRestore();
      factory.mockRestore();
    }
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
    expect(data(watchdog.stdout)).toMatchObject({ signaled: false, spawned: false, guardian: false });
    expect(JSON.stringify(data(activate.stdout))).not.toContain("ctl");
    expect(JSON.stringify(data(activate.stdout))).not.toContain("re-adopt");
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
      expect(data(watchdog.stdout).signaled).toBe(false);
      expect(spy).not.toHaveBeenCalled();

      const confirmed = await captureCli(["runtime", "re-adopt", "--confirm"], {
        discoveryPath: "/dev/null",
        boxRuntimeRoot,
      });
      expect(confirmed.code, confirmed.stderr).toBe(0);
      expect(data(confirmed.stdout)).toMatchObject({ signaled: false, spawned: false, guardian: false });
      expect(spy).not.toHaveBeenCalled();
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

  test("activate --mode route admits openai* with https endpoint and apiKeyRef", async () => {
    const boxRuntimeRoot = await withRoot();
    await writeFile(join(boxRuntimeRoot, "models.json"), `${JSON.stringify({
      version: 1,
      models: {
        "openai/gpt-4o-mini": {
          id: "openai/gpt-4o-mini",
          provider: "openai",
          model: "gpt-4o-mini",
          endpoint: "https://sub2api.test/v1",
          apiKeyRef: "env:OPENAI_API_KEY",
        },
      },
      assignments: { main: "openai/gpt-4o-mini", agents: {} },
    })}\n`);
    const activate = await captureCli(["runtime", "activate", "--mode", "route"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    expect(data(activate.stdout)).toMatchObject({ desired: "route", inject: false });
    const refused = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(refused.code).toBe(2);
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
