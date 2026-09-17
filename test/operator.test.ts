import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps, type CliDeps } from "../packages/cli/src/deps.ts";
import {
  classifyOperatorHost,
  hostObservePorts,
  hostSwitchPorts,
  operatorNext,
  powerOnNext,
  type OperatorHost,
} from "../packages/cli/src/commands/operator.ts";
import { hostControlPorts } from "../packages/cli/src/commands/runtime.ts";
import { hostSourcePorts, profileWriteNext } from "../packages/cli/src/host-source.ts";
import { BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import { captureCli, parseJson, sampleAgents, startMockGateway, writeDiscovery } from "./helpers.ts";

const originalSwitch = { enable: hostSwitchPorts.enable, disable: hostSwitchPorts.disable };
const originalControl = { apply: hostControlPorts.apply, stopPatched: hostControlPorts.stopPatched };
const originalObserve = { classifyLive: hostObservePorts.classifyLive };
const originalSource = { readLiveSha: hostSourcePorts.readLiveSha, readProfileSha: hostSourcePorts.readProfileSha };
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const WRITE_NEXT_A = profileWriteNext(SHA_A);

beforeEach(() => {
  hostObservePorts.classifyLive = async () => ({ host: "official", hostReason: null });
  hostSourcePorts.readLiveSha = async () => null;
  hostSourcePorts.readProfileSha = async () => null;
});

afterEach(() => {
  hostSwitchPorts.enable = originalSwitch.enable;
  hostSwitchPorts.disable = originalSwitch.disable;
  hostControlPorts.apply = originalControl.apply;
  hostControlPorts.stopPatched = originalControl.stopPatched;
  hostObservePorts.classifyLive = originalObserve.classifyLive;
  hostSourcePorts.readLiveSha = originalSource.readLiveSha;
  hostSourcePorts.readProfileSha = originalSource.readProfileSha;
});

function stubHost(host: OperatorHost, hostReason: string | null = null): { host: { value: OperatorHost } } {
  const state = { value: host };
  hostObservePorts.classifyLive = async () => ({ host: state.value, hostReason });
  return { host: state };
}

async function desiredMode(root: string): Promise<string> {
  return JSON.parse(await readFile(join(root, "config.json"), "utf8")).runtime.desiredMode as string;
}

async function writeDesired(root: string, mode: "disabled" | "route" | "identity"): Promise<void> {
  await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "config.json"), `${JSON.stringify({ schemaVersion: 2, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: mode } })}\n`, { mode: 0o600 });
}

async function run(argv: string[], extras?: { agents?: unknown[]; boxRuntimeRoot?: string }) {
  const gateway = await startMockGateway({ agents: extras?.agents ?? sampleAgents() });
  const dir = await mkdtemp(join(tmpdir(), "grokbox-operator-"));
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const deps: Partial<CliDeps> = {
    configDir: dir,
    discoveryPath,
    env: {},
    transport: "local",
    stdinIsTTY: false,
    daemonSocket: join(dir, "missing.sock"),
    ...(extras?.boxRuntimeRoot ? { boxRuntimeRoot: extras.boxRuntimeRoot } : {}),
  };
  await writeProfileFile(dir, "default", { version: 1, transport: "local", gateway_discovery: discoveryPath });
  try {
    return { result: await captureCli(argv, deps), gateway };
  } catch (error) {
    gateway.stop();
    throw error;
  }
}

function runningAgent() {
  const agents = sampleAgents() as Array<Record<string, unknown>>;
  const alpha = agents.find((row) => row.name === "alpha");
  if (alpha) {
    alpha.isRunning = true;
    alpha.isRunningTurn = true;
  }
  return agents;
}

test("doctor includes computer next when services are down", async () => {
  const { result, gateway } = await run(["doctor"]);
  try {
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: {
        next: string;
        operator?: {
          daemon: string;
          next: string;
          host: string;
          hostReason: string | null;
          screenIdle: boolean;
          titleSync: boolean;
        };
      };
    };
    expect(body.data.operator?.daemon).toBe("down");
    expect(body.data.operator?.titleSync).toBe(false);
    expect(body.data.operator?.screenIdle).toBe(false);
    expect(body.data.operator?.host).toBe("official");
    expect(body.data.operator?.next).toBe("grokbox on");
    expect(body.data.next).toBe("grokbox on");
    expect(body.data.operator?.hostReason).toBeNull();
  } finally {
    gateway.stop();
  }
});

test("doctor reports source_mismatch with profile-write next when SHAs differ", async () => {
  hostObservePorts.classifyLive = async () => ({ host: "official", hostReason: null });
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_B;
  const { result, gateway } = await run(["doctor"]);
  try {
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { next: string; operator?: { host: string; hostReason: string | null; next: string; liveShaPrefix?: string; profileShaPrefix?: string; liveSourceSha?: string } };
    };
    expect(body.data.operator?.host).toBe("unknown");
    expect(body.data.operator?.hostReason).toBe("source_mismatch");
    expect(body.data.operator?.next).toBe(WRITE_NEXT_A);
    expect(body.data.next).toBe(WRITE_NEXT_A);
    expect(body.data.next).toContain(SHA_A);
    expect(body.data.next).not.toContain("<sourceSha256>");
    expect(body.data.operator?.liveSourceSha).toBe(SHA_A);
    expect(body.data.operator?.liveShaPrefix).toBe("a".repeat(12));
    expect(body.data.operator?.profileShaPrefix).toBe("b".repeat(12));
  } finally {
    gateway.stop();
  }
});

test("upgrade without --yes is invalid usage", async () => {
  const { result, gateway } = await run(["upgrade"]);
  try {
    expect(result.code).toBe(2);
  } finally {
    gateway.stop();
  }
});

test("upgrade --yes recovers from desired disabled by setting route then enable", async () => {
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-desired-"));
  await writeDesired(boxRuntimeRoot, "disabled");
  hostControlPorts.apply = async () => ({
    outcome: "signaled",
    reason: null,
    signaled: true,
    spawned: true,
    guardian: true,
    operationId: "test-apply",
  });
  const { result, gateway } = await run(["upgrade", "--yes"], { boxRuntimeRoot });
  try {
    expect(result.code).toBe(0);
    expect(await desiredMode(boxRuntimeRoot)).toBe("route");
    expect(parseJson(result.stdout)).toMatchObject({
      data: { host: "enable-requested", enable: { outcome: "signaled" } },
    });
  } finally {
    gateway.stop();
  }
});

test("upgrade --yes refreshes Host on this computer", async () => {
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["upgrade", "--yes"]);
  try {
    expect(result.code).toBe(0);
    expect(enabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { host: "enable-requested", enable: { stub: "enable" } },
    });
  } finally {
    gateway.stop();
  }
});

test("upgrade --yes refuses source mismatch before enable", async () => {
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { stub: "enable" };
  };
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_B;
  const { result, gateway } = await run(["upgrade", "--yes"]);
  try {
    expect(result.code).toBe(72);
    expect(enabled).toBe(0);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_source_mismatch", next: WRITE_NEXT_A, hostReason: "source_mismatch" },
    });
  } finally {
    gateway.stop();
  }
});

test("upgrade is box-local and refuses --profile", async () => {
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  const profile = await captureCli(["--profile", "default", "upgrade", "--yes"], {
    env: {}, transport: "local", stdinIsTTY: false,
  });
  expect(profile.code).toBe(65);
  expect(parseJson(profile.stderr)).toMatchObject({ error: { code: "runtime_local_only" } });
});

test("upgrade maps box-local runtime errors instead of gateway_internal", async () => {
  hostSwitchPorts.enable = async () => {
    throw new BoxRuntimeError(
      "runtime_local_only",
      "Box-local runtime commands cannot use --profile, daemon, SSH, or generic remote exec.",
    );
  };
  const { result, gateway } = await run(["upgrade", "--yes"]);
  try {
    expect(result.code).toBe(65);
    expect(parseJson(result.stderr)).toMatchObject({ error: { code: "runtime_local_only" } });
  } finally {
    gateway.stop();
  }
});

test("operator group is not a public command", async () => {
  const { result, gateway } = await run(["operator", "on"]);
  try {
    expect(result.code).toBe(2);
  } finally {
    gateway.stop();
  }
});

function liveBridge(origin: string | null, reason: string | null = null) {
  return { facets: { bridge: { value: { origin, reason } } } };
}

test("host classification never emits bare unknown", () => {
  expect(classifyOperatorHost({ host: { origin: "official", reason: null } })).toEqual({ host: "official", hostReason: null });
  expect(classifyOperatorHost({ host: { origin: "grokbox-attested", reason: null } })).toEqual({ host: "custom", hostReason: null });
  expect(classifyOperatorHost({
    host: { origin: "grokbox-attested", reason: "stale_attestation" },
    driftedSlices: ["compact"],
  })).toEqual({ host: "unknown", hostReason: "stale_attestation" });
  expect(classifyOperatorHost({ host: { origin: "grokbox-unattested", reason: "unmanaged_preload" } }))
    .toEqual({ host: "unknown", hostReason: "unmanaged_preload" });
  expect(classifyOperatorHost({ host: { origin: "ambiguous", reason: null } }))
    .toEqual({ host: "unknown", hostReason: "ambiguous" });
  expect(classifyOperatorHost({ host: { origin: "other", reason: null } }))
    .toEqual({ host: "unknown", hostReason: "observation_unavailable" });
  expect(operatorNext({ daemon: "up", host: "official", hostReason: null })).toBe("grokbox host start");
  expect(operatorNext({ daemon: "down", host: "official", hostReason: null })).toBe("grokbox on");
  expect(operatorNext({ daemon: "up", host: "unknown", hostReason: "stale_attestation" })).toBe("grokbox upgrade --yes");
  expect(powerOnNext("official")).toBe("grokbox host start");
  expect(powerOnNext("custom")).toBe("none");
});

test("host classification reads live facets.bridge.value, not a missing top-level host", () => {
  expect(classifyOperatorHost(liveBridge("official"))).toEqual({ host: "official", hostReason: null });
  expect(classifyOperatorHost(liveBridge("grokbox-attested"))).toEqual({ host: "custom", hostReason: null });
  expect(classifyOperatorHost(liveBridge("grokbox-attested", "stale_attestation")))
    .toEqual({ host: "unknown", hostReason: "stale_attestation" });
  expect(classifyOperatorHost(liveBridge("grokbox-unattested", "unmanaged_preload")))
    .toEqual({ host: "unknown", hostReason: "unmanaged_preload" });
  expect(classifyOperatorHost(liveBridge("ambiguous"))).toEqual({ host: "unknown", hostReason: "ambiguous" });
  expect(classifyOperatorHost({})).toEqual({ host: "unknown", hostReason: "observation_unavailable" });
  expect(classifyOperatorHost({ facets: { bridge: { value: null } } }))
    .toEqual({ host: "unknown", hostReason: "observation_unavailable" });
  expect(classifyOperatorHost({ facets: { bridge: { gap: "unavailable", value: null } } }))
    .toEqual({ host: "unknown", hostReason: "observation_unavailable" });
  expect(operatorNext({
    daemon: "up",
    ...classifyOperatorHost(liveBridge("official")),
  })).toBe("grokbox host start");
});

test("host start is already_started when custom and does not enable", async () => {
  stubHost("custom");
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "start"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(0);
    expect(enabled).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({
      data: {
        command: "start",
        desired: "custom",
        actual: "custom",
        outcome: "already_started",
        next: "none",
        hostReason: null,
        forced: false,
      },
    });
  } finally {
    gateway.stop();
  }
});

test("host start applies when official and no bots are running", async () => {
  const state = stubHost("official");
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    state.host.value = "custom";
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "start"]);
  try {
    expect(result.code).toBe(0);
    expect(enabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: {
        command: "start",
        desired: "custom",
        actual: "custom",
        outcome: "started",
        next: "none",
        forced: false,
        receipt: { stub: "enable" },
      },
    });
  } finally {
    gateway.stop();
  }
});

test("host start refuses running bots and points at --force", async () => {
  stubHost("official");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  const { result, gateway } = await run(["host", "start"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(71);
    const body = parseJson(result.stderr) as {
      error: { code: string; message: string; running: Array<{ id: string; name: string }>; next: string };
    };
    expect(body.error.code).toBe("host_switch_blocked");
    expect(body.error.next).toBe("grokbox host start --force");
    expect(body.error.message).toContain("kills Host");
    expect(body.error.running.some((bot) => bot.name === "alpha")).toBe(true);
  } finally {
    gateway.stop();
  }
});

test("host start --force applies even when bots are running", async () => {
  const state = stubHost("official");
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    state.host.value = "custom";
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "start", "--force"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(0);
    expect(enabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { outcome: "started", forced: true, receipt: { stub: "enable" } },
    });
  } finally {
    gateway.stop();
  }
});

test("host start refuses source mismatch even with --force", async () => {
  stubHost("official");
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_B;
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "start", "--force"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(72);
    expect(enabled).toBe(0);
    expect(parseJson(result.stderr)).toMatchObject({
      error: {
        code: "host_source_mismatch",
        next: WRITE_NEXT_A,
        hostReason: "source_mismatch",
        liveShaPrefix: "a".repeat(12),
        profileShaPrefix: "b".repeat(12),
      },
    });
  } finally {
    gateway.stop();
  }
});

test("host start remaps enable source-mismatch receipt", async () => {
  stubHost("official");
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_A;
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { outcome: "refused", reason: "source-mismatch" };
  };
  const { result, gateway } = await run(["host", "start"]);
  try {
    expect(result.code).toBe(72);
    expect(enabled).toBe(1);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_source_mismatch", next: WRITE_NEXT_A, hostReason: "source_mismatch" },
    });
  } finally {
    gateway.stop();
  }
});

test("host start refuses stale_attestation without enable", async () => {
  stubHost("unknown", "stale_attestation");
  let enabled = 0;
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "start"]);
  try {
    expect(result.code).toBe(72);
    expect(enabled).toBe(0);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_mismatch", next: "grokbox upgrade --yes", hostReason: "stale_attestation" },
    });
  } finally {
    gateway.stop();
  }
});

test("host start refuses observation_unavailable with doctor next", async () => {
  stubHost("unknown", "observation_unavailable");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  const { result, gateway } = await run(["host", "start"]);
  try {
    expect(result.code).toBe(72);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_mismatch", next: "grokbox doctor", hostReason: "observation_unavailable" },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop is already_stopped when official even if bots are running", async () => {
  stubHost("official");
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    return { stub: "disable" };
  };
  const { result, gateway } = await run(["host", "stop"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { command: "stop", desired: "official", actual: "official", outcome: "already_stopped", next: "none" },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop applies when custom and no bots are running", async () => {
  const state = stubHost("custom");
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    state.host.value = "official";
    return { stub: "disable" };
  };
  const { result, gateway } = await run(["host", "stop"]);
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { outcome: "stopped", actual: "official", forced: false, receipt: { stub: "disable" } },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop refuses running bots without switching", async () => {
  stubHost("custom");
  hostSwitchPorts.disable = async () => {
    throw new Error("must not switch Host");
  };
  const { result, gateway } = await run(["host", "stop"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(71);
    const body = parseJson(result.stderr) as { error: { code: string; next: string } };
    expect(body.error.code).toBe("host_switch_blocked");
    expect(body.error.next).toBe("grokbox host stop --force");
  } finally {
    gateway.stop();
  }
});

test("host stop --force reverts even when bots are running", async () => {
  const state = stubHost("custom");
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    state.host.value = "official";
    return { stub: "disable" };
  };
  const { result, gateway } = await run(["host", "stop", "--force"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { outcome: "stopped", forced: true, receipt: { stub: "disable" } },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop does not refuse source mismatch", async () => {
  const state = stubHost("custom");
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_B;
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    state.host.value = "official";
    return { stub: "disable" };
  };
  const { result, gateway } = await run(["host", "stop"]);
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: { outcome: "stopped", actual: "unknown", hostReason: "source_mismatch", next: WRITE_NEXT_A },
    });
  } finally {
    gateway.stop();
  }
});

test("host start is box-local and fail-closed when running bots cannot be listed", async () => {
  stubHost("official");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  const profile = await captureCli(["--profile", "default", "host", "start"], {
    env: {}, transport: "local", stdinIsTTY: false,
  });
  expect(profile.code).toBe(65);
  expect(parseJson(profile.stderr)).toMatchObject({ error: { code: "runtime_local_only" } });
  const listed = await captureCli(["host", "start"], {
    discoveryPath: "/dev/null", env: {}, transport: "local", stdinIsTTY: false,
  });
  expect(listed.code).toBe(71);
  expect(parseJson(listed.stderr)).toMatchObject({
    error: { code: "host_switch_blocked", next: "grokbox host start --force" },
  });
});

test("host restart always bounces even when already custom", async () => {
  const state = stubHost("custom");
  let enabled = 0;
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    state.host.value = "official";
    return { stub: "disable" };
  };
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    state.host.value = "custom";
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "restart"]);
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(1);
    expect(enabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      data: {
        command: "restart",
        desired: "custom",
        actual: "custom",
        outcome: "restarted",
        next: "none",
        receipt: { disable: { stub: "disable" }, enable: { stub: "enable" } },
      },
    });
  } finally {
    gateway.stop();
  }
});

test("host restart refuses running bots without mutating", async () => {
  stubHost("custom");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  hostSwitchPorts.disable = async () => {
    throw new Error("must not switch Host");
  };
  const { result, gateway } = await run(["host", "restart"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(71);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_switch_blocked", next: "grokbox host restart --force" },
    });
  } finally {
    gateway.stop();
  }
});

test("host restart --force bounces when bots are running", async () => {
  const state = stubHost("custom");
  let enabled = 0;
  let disabled = 0;
  hostSwitchPorts.disable = async () => {
    disabled += 1;
    state.host.value = "official";
    return { stub: "disable" };
  };
  hostSwitchPorts.enable = async () => {
    enabled += 1;
    state.host.value = "custom";
    return { stub: "enable" };
  };
  const { result, gateway } = await run(["host", "restart", "--force"], { agents: runningAgent() });
  try {
    expect(result.code).toBe(0);
    expect(disabled).toBe(1);
    expect(enabled).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({ data: { outcome: "restarted", forced: true } });
  } finally {
    gateway.stop();
  }
});

test("host restart refuses mismatch without mutating", async () => {
  stubHost("custom");
  hostSourcePorts.readLiveSha = async () => SHA_A;
  hostSourcePorts.readProfileSha = async () => SHA_B;
  let mutated = 0;
  hostSwitchPorts.enable = async () => {
    mutated += 1;
    return { stub: "enable" };
  };
  hostSwitchPorts.disable = async () => {
    mutated += 1;
    return { stub: "disable" };
  };
  const { result, gateway } = await run(["host", "restart"]);
  try {
    expect(result.code).toBe(72);
    expect(mutated).toBe(0);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_source_mismatch", next: WRITE_NEXT_A },
    });
  } finally {
    gateway.stop();
  }
});

test("host start already_started repairs desired disabled to route", async () => {
  stubHost("custom");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not enable");
  };
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-desired-"));
  await writeDesired(boxRuntimeRoot, "disabled");
  const { result, gateway } = await run(["host", "start"], { boxRuntimeRoot });
  try {
    expect(result.code).toBe(0);
    expect(await desiredMode(boxRuntimeRoot)).toBe("route");
    expect(parseJson(result.stdout)).toMatchObject({
      data: { command: "start", outcome: "already_started", actual: "custom" },
    });
  } finally {
    gateway.stop();
  }
});

test("host start remaps desired-disabled enable receipt to activate next", async () => {
  stubHost("official");
  hostSwitchPorts.enable = async () => ({ outcome: "refused", reason: "desired-disabled" });
  const { result, gateway } = await run(["host", "start"]);
  try {
    expect(result.code).toBe(72);
    expect(parseJson(result.stderr)).toMatchObject({
      error: {
        code: "host_mismatch",
        next: "grokbox runtime activate --mode route",
        hostReason: "desired-disabled",
      },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop fails closed when disable leaves custom", async () => {
  stubHost("custom");
  hostSwitchPorts.disable = async () => ({ desired: "disabled", host: "desired-disabled" });
  const { result, gateway } = await run(["host", "stop"]);
  try {
    expect(result.code).toBe(72);
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_mismatch", next: "grokbox doctor", hostReason: "still_custom" },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop restores previous desired when unload fails", async () => {
  stubHost("custom");
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-desired-"));
  await writeDesired(boxRuntimeRoot, "route");
  hostControlPorts.stopPatched = async () => ({
    ok: false,
    recoveryRequired: true,
    code: "no-attestation",
    signaled: false,
    diskShaBefore: "sha",
    diskShaAfter: "sha",
    census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
    coverage: "none",
  });
  const { result, gateway } = await run(["host", "stop"], { boxRuntimeRoot });
  try {
    expect(result.code).toBe(72);
    expect(await desiredMode(boxRuntimeRoot)).toBe("route");
    expect(parseJson(result.stderr)).toMatchObject({
      error: { code: "host_mismatch", hostReason: "no-attestation", next: "grokbox doctor" },
    });
  } finally {
    gateway.stop();
  }
});

test("host stop then start roundtrip does not leave desired disabled", async () => {
  const state = stubHost("custom");
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-desired-"));
  await writeDesired(boxRuntimeRoot, "route");
  hostSwitchPorts.disable = async () => {
    await writeDesired(boxRuntimeRoot, "disabled");
    state.host.value = "official";
    return { desired: "disabled", signaled: true, coverage: "none", host: "official" };
  };
  hostControlPorts.apply = async () => {
    state.host.value = "custom";
    return {
      outcome: "signaled",
      reason: null,
      signaled: true,
      spawned: true,
      guardian: true,
      operationId: "test-apply",
    };
  };
  const stopped = await run(["host", "stop"], { boxRuntimeRoot });
  try {
    expect(stopped.result.code).toBe(0);
    expect(await desiredMode(boxRuntimeRoot)).toBe("disabled");
    expect(parseJson(stopped.result.stdout)).toMatchObject({
      data: { outcome: "stopped", actual: "official" },
    });
  } finally {
    stopped.gateway.stop();
  }
  const started = await run(["host", "start"], { boxRuntimeRoot });
  try {
    expect(started.result.code).toBe(0);
    expect(await desiredMode(boxRuntimeRoot)).toBe("route");
    expect(parseJson(started.result.stdout)).toMatchObject({
      data: { outcome: "started", actual: "custom", desired: "custom" },
    });
  } finally {
    started.gateway.stop();
  }
});

test("host restart does not leave desired disabled after success", async () => {
  const state = stubHost("custom");
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-desired-"));
  await writeDesired(boxRuntimeRoot, "route");
  hostSwitchPorts.disable = async () => {
    await writeDesired(boxRuntimeRoot, "disabled");
    state.host.value = "official";
    return { desired: "disabled", signaled: true, coverage: "none", host: "official" };
  };
  hostControlPorts.apply = async () => {
    state.host.value = "custom";
    return {
      outcome: "signaled",
      reason: null,
      signaled: true,
      spawned: true,
      guardian: true,
      operationId: "test-apply",
    };
  };
  const { result, gateway } = await run(["host", "restart"], { boxRuntimeRoot });
  try {
    expect(result.code).toBe(0);
    expect(await desiredMode(boxRuntimeRoot)).toBe("route");
    expect(parseJson(result.stdout)).toMatchObject({
      data: { outcome: "restarted", actual: "custom", desired: "custom" },
    });
  } finally {
    gateway.stop();
  }
});

test("removed host on/off and power Host-switch flags are invalid usage", async () => {
  const on = await run(["host", "on"]);
  try {
    expect(on.result.code).toBe(2);
  } finally {
    on.gateway.stop();
  }
  const off = await run(["host", "off"]);
  try {
    expect(off.result.code).toBe(2);
  } finally {
    off.gateway.stop();
  }
  const yes = await run(["on", "--yes"]);
  try {
    expect(yes.result.code).toBe(2);
  } finally {
    yes.gateway.stop();
  }
  const revert = await run(["off", "--revert", "--yes"]);
  try {
    expect(revert.result.code).toBe(2);
  } finally {
    revert.gateway.stop();
  }
});

test("host status/realign/logs are reserved stubs", async () => {
  const status = await run(["host", "status"]);
  try {
    expect(status.result.code).toBe(2);
    expect(parseJson(status.result.stderr)).toMatchObject({
      error: { code: "invalid_usage", next: "grokbox doctor" },
    });
  } finally {
    status.gateway.stop();
  }
  const realign = await run(["host", "realign"]);
  try {
    expect(realign.result.code).toBe(2);
    expect(parseJson(realign.result.stderr)).toMatchObject({
      error: { code: "invalid_usage", next: "grokbox upgrade --yes" },
    });
  } finally {
    realign.gateway.stop();
  }
  const logs = await run(["host", "logs"]);
  try {
    expect(logs.result.code).toBe(2);
    expect(parseJson(logs.result.stderr)).toMatchObject({
      error: { code: "invalid_usage", next: "grokbox doctor" },
    });
  } finally {
    logs.gateway.stop();
  }
});

test("top-level on starts services without switching Host and annotates host start", async () => {
  stubHost("official");
  hostSwitchPorts.enable = async () => {
    throw new Error("must not switch Host");
  };
  const gateway = await startMockGateway();
  const dir = await mkdtemp(join(tmpdir(), "grokbox-operator-on-"));
  const discoveryPath = await writeDiscovery({
    port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token,
  });
  const daemonSocket = join(dir, "daemon.sock");
  const deps: Partial<CliDeps> = {
    configDir: dir, discoveryPath, env: {}, transport: "local", stdinIsTTY: false, daemonSocket,
  };
  await writeDaemonConfig(dir, { version: 1 });
  await writeProfileFile(dir, "default", { version: 1, transport: "local", gateway_discovery: discoveryPath, daemon_socket: daemonSocket });
  const daemon = await startDaemonHost({ ...createProductionDeps(), ...deps, transport: "local" }, daemonSocket);
  try {
    const result = await captureCli(["on"], deps);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { daemon: string; titleSync: boolean; screenIdle: boolean; host: string; next: string };
    };
    expect(body.data.host).toBe("unchanged");
    expect(body.data.titleSync).toBe(true);
    expect(body.data.screenIdle).toBe(true);
    expect(["up", "started"]).toContain(body.data.daemon);
    expect(body.data.next).toBe("grokbox host start");
  } finally {
    await daemon.close();
    gateway.stop();
  }
});
