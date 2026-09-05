import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import { readDaemonConfig, validateDaemonConfig, writeDaemonConfig } from "../src/daemon/config.ts";
import { DesktopManager, type DesktopIo } from "../src/daemon/desktop.ts";
import { startDaemonHost, type DaemonHost } from "../src/daemon/host.ts";
import {
  classifyDesktop,
  DEFAULT_MIN_IDLE_MS,
  displayFromEnviron,
  inspectDesktopProc,
  type DesktopWorld,
} from "../src/desktop.ts";
import { createProductionDeps } from "../src/deps.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery, type MockGateway } from "./helpers.ts";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const AGENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const AGENT_KEEP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const skillsDir = join(import.meta.dir, "..", "skills");

function world(overrides: Partial<DesktopWorld> = {}): DesktopWorld {
  return {
    nowMs: 2_000_000,
    assignments: { [AGENT_A]: 2, [AGENT_B]: 3, [AGENT_KEEP]: 10 },
    names: { [AGENT_A]: "research", [AGENT_B]: "idle-bot", [AGENT_KEEP]: "twitter" },
    litDisplays: new Set([2, 3, 10]),
    displayStartedAtMs: { 2: 0, 3: 0, 10: 0 },
    transcriptWrittenAtMs: { [AGENT_A]: 2_000_000, [AGENT_B]: 0, [AGENT_KEEP]: 0 },
    busyMarkers: new Set(),
    grokDisplays: new Set(),
    taskDisplays: new Set(),
    startWindowDisplays: new Set(),
    ...overrides,
  };
}

describe("desktop proc inspectors", () => {
  test("does not treat exec-daemon computer-use flags as a Task", () => {
    const cmdline = ["/exec-daemon/node", "/exec-daemon/index.js", "serve", "--computer-use-enabled", "--computer-use-lazy-init"].join("\0");
    expect(inspectDesktopProc(cmdline)).toEqual({ grok: false, task: false, startWindow: undefined });
  });

  test("detects grok argv0 and start-window display", () => {
    expect(inspectDesktopProc("/usr/local/bin/grok\0--effort\0xhigh")).toMatchObject({ grok: true, task: false });
    expect(inspectDesktopProc("/usr/local/bin/start-window\x0012")).toEqual({
      grok: false,
      task: false,
      startWindow: 12,
    });
  });

  test("parses DISPLAY from NUL environ without prefix collisions", () => {
    expect(displayFromEnviron("HOME=/home/box\0DISPLAY=:10\0PATH=/usr/bin")).toBe(10);
    expect(displayFromEnviron("DISPLAY=:1\0")).toBe(1);
  });
});

describe("desktop classifier", () => {
  test("marks the main desktop and keep/floor agents protected, not idle", () => {
    const rows = classifyDesktop(world({ assignments: { [AGENT_A]: 1, [AGENT_B]: 2 } }), {
      minIdleMs: DEFAULT_MIN_IDLE_MS,
      minDisplayAgeMs: DEFAULT_MIN_IDLE_MS,
      floorAgentIds: [],
      keepAgentIds: [],
    });
    expect(rows.find((row) => row.display === 1)).toMatchObject({
      protected: true,
      idle: false,
      busyReason: "protected",
    });
    expect(rows.find((row) => row.display === 2)?.idle).toBe(true);
  });

  test("requires lit, aged, quiet transcript, and no busy markers", () => {
    const policy = {
      minIdleMs: 1_000,
      minDisplayAgeMs: 1_000,
      floorAgentIds: [AGENT_KEEP],
      keepAgentIds: [],
    };
    const idle = classifyDesktop(world({
      nowMs: 10_000,
      transcriptWrittenAtMs: { [AGENT_A]: 10_000, [AGENT_B]: 0, [AGENT_KEEP]: 0 },
      displayStartedAtMs: { 2: 0, 3: 0, 10: 0 },
    }), policy);
    expect(idle.find((row) => row.agentId === AGENT_B)).toMatchObject({ idle: true, busyReason: null });
    expect(idle.find((row) => row.agentId === AGENT_A)?.busyReason).toBe("recent-transcript");
    expect(idle.find((row) => row.agentId === AGENT_KEEP)).toMatchObject({
      protected: true,
      busyReason: "protected",
    });

    const busy = classifyDesktop(world({
      nowMs: 10_000,
      grokDisplays: new Set([3]),
      transcriptWrittenAtMs: { [AGENT_B]: 0 },
    }), policy);
    expect(busy.find((row) => row.display === 3)?.busyReason).toBe("grok");

    const dark = classifyDesktop(world({
      nowMs: 10_000,
      litDisplays: new Set([2, 10]),
      transcriptWrittenAtMs: { [AGENT_B]: 0 },
    }), policy);
    expect(dark.find((row) => row.display === 3)).toMatchObject({ lit: false, idle: false, busyReason: "dark" });
  });

  test("does not emit owner tokens or extra seating fields", () => {
    const rows = classifyDesktop(world(), {
      minIdleMs: 1,
      minDisplayAgeMs: 1,
      floorAgentIds: [],
      keepAgentIds: [],
    });
    expect(JSON.stringify(rows)).not.toContain("token");
    expect(rows.every((row) => Object.keys(row).sort().join(",") === "agentId,busyReason,display,idle,lit,protected")).toBe(true);
  });

  test("mixed-case keep id protects the same-valued seated agent", () => {
    const UPPER_A = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
    const rows = classifyDesktop(world({
      assignments: { [AGENT_A]: 2 },
      litDisplays: new Set([2]),
      displayStartedAtMs: { 2: 0 },
      transcriptWrittenAtMs: { [AGENT_A]: 0 },
    }), {
      minIdleMs: DEFAULT_MIN_IDLE_MS,
      minDisplayAgeMs: DEFAULT_MIN_IDLE_MS,
      floorAgentIds: [],
      keepAgentIds: [UPPER_A],
    });
    expect(rows.find((row) => row.agentId === AGENT_A)).toMatchObject({
      protected: true,
      idle: false,
      busyReason: "protected",
    });
  });
});

describe("desktop daemon commands", () => {
  let host: DaemonHost | undefined;
  let gateway: MockGateway | undefined;

  afterEach(async () => {
    await host?.close().catch(() => undefined);
    gateway?.stop();
    host = undefined;
    gateway = undefined;
  });

  async function harness(current: { value: DesktopWorld }, stopped: number[] = []) {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-"));
    const socket = join(configDir, "run", "daemon.sock");
    gateway = await startMockGateway();
    const discoveryPath = await writeDiscovery({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: gateway.token,
    });
    const io: DesktopIo = {
      readWorld: async () => current.value,
      stopWindow: async (display) => {
        stopped.push(display);
        current.value = {
          ...current.value,
          litDisplays: new Set([...current.value.litDisplays].filter((item) => item !== display)),
        };
      },
      reapLogs: async () => {},
    };
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      discoveryPath,
      daemonSocket: socket,
      transport: "local" as const,
    };
    await writeDaemonConfig(configDir, {
      version: 1,
      desktop: { floorAgentIds: [AGENT_KEEP], minIdleMs: 600_000 },
    });
    host = await startDaemonHost(deps, socket, undefined, [], undefined, {
      floorAgentIds: [AGENT_KEEP],
      minIdleMs: 600_000,
    }, io);
    await writeProfileFile(configDir, "daemon", {
      version: 1,
      transport: "daemon",
      daemon_socket: socket,
      gateway_discovery: discoveryPath,
    });
    const run = async (argv: string[]) =>
      await captureCli(argv, {
        configDir,
        env: {},
        discoveryPath: "/must-not-be-used.json",
        daemonSocket: socket,
        transport: "auto",
        skillsDir,
      });
    return { configDir, run };
  }

  test("status classifies idle versus protected without calling stop-window", async () => {
    const stopped: number[] = [];
    const current = { value: world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 2_000_000, [AGENT_B]: 0, [AGENT_KEEP]: 0 } }) };
    const { run } = await harness(current, stopped);
    const result = await run(["--profile", "daemon", "desktop", "status"]);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as { data: { displays: Array<Record<string, unknown>>; pruneEnabled: boolean } };
    expect(body.data.pruneEnabled).toBe(false);
    expect(body.data.displays.find((row) => row.agentId === AGENT_B)).toMatchObject({ idle: true, protected: false });
    expect(body.data.displays.find((row) => row.agentId === AGENT_KEEP)).toMatchObject({ protected: true, idle: false });
    expect(JSON.stringify(body)).not.toContain("token");
    expect(stopped).toEqual([]);
    const table = await run(["--profile", "daemon", "--table", "desktop", "status"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("keepAgentIds");
    expect(table.stdout).toContain("floorAgentIds");
    expect(table.stdout).toContain("pruneEnabled");
  });

  test("keep add persists on daemon config and prune dry-run plans only idle forks", async () => {
    const current = { value: world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } }) };
    const { configDir, run } = await harness(current);
    const added = await run(["--profile", "daemon", "desktop", "keep", "add", "research"]);
    expect(added.code).toBe(0);
    const persisted = await readDaemonConfig(configDir);
    expect(persisted.desktop?.keepAgentIds).toEqual([AGENT_A]);
    const plan = await run(["--profile", "daemon", "desktop", "prune", "run"]);
    expect(plan.code).toBe(0);
    const body = parseJson(plan.stdout) as { data: { dryRun: boolean; rows: Array<{ agentId: string; outcome: string }> } };
    expect(body.data.dryRun).toBe(true);
    expect(body.data.rows.find((row) => row.agentId === AGENT_A)?.outcome).toBe("kept");
    expect(body.data.rows.find((row) => row.agentId === AGENT_B)?.outcome).toBe("planned");
    expect(body.data.rows.find((row) => row.agentId === AGENT_KEEP)?.outcome).toBe("kept");
  });

  test("keep remove cannot drop the daemon floor and prune --yes stops only idle forks", async () => {
    const stopped: number[] = [];
    const current = { value: world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } }) };
    const { run } = await harness(current, stopped);
    const refused = await run(["--profile", "daemon", "desktop", "keep", "remove", AGENT_KEEP, "--yes"]);
    expect(refused.code).toBe(2);
    const live = await run(["--profile", "daemon", "desktop", "prune", "run", "--yes"]);
    expect(live.code).toBe(0);
    const body = parseJson(live.stdout) as { data: { dryRun: boolean; rows: Array<{ display: number; outcome: string }> } };
    expect(body.data.dryRun).toBe(false);
    expect(body.data.rows.filter((row) => row.outcome === "stopped").map((row) => row.display).sort()).toEqual([2, 3]);
    expect(body.data.rows.find((row) => row.display === 10)?.outcome).toBe("kept");
    expect(stopped.sort()).toEqual([2, 3]);
  });

  test("overlapping prune is skipped and a raced ensureReady row is not stopped", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-race-"));
    let reads = 0;
    const idle = world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } });
    const busy = world({
      nowMs: 2_000_000,
      grokDisplays: new Set([2]),
      transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 },
    });
    const stopped: number[] = [];
    const io: DesktopIo = {
      readWorld: async () => {
        reads += 1;
        return reads === 1 ? idle : busy;
      },
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
    };
    const manager = await DesktopManager.create(configDir, () => 2_000_000, { minIdleMs: 600_000, floorAgentIds: [AGENT_KEEP] }, io);
    const raced = await manager.prune(true);
    expect(raced.rows.find((row) => row.display === 2)?.outcome).toBe("raced");
    expect(stopped).not.toContain(2);
    await manager.close();
  });

  test("prune enable persists and Gateway-only profiles cannot read desktop", async () => {
    const current = { value: world() };
    const { configDir, run } = await harness(current);
    const enabled = await run(["--profile", "daemon", "desktop", "prune", "enable"]);
    expect(enabled.code).toBe(0);
    expect((await readDaemonConfig(configDir)).desktop?.pruneEnabled).toBe(true);
    const disabled = await run(["--profile", "daemon", "desktop", "prune", "disable"]);
    expect(disabled.code).toBe(0);
    const configDir2 = await mkdtemp(join(tmpdir(), "grokbox-desktop-gw-"));
    await writeProfileFile(configDir2, "gw", { version: 1, transport: "gateway", gateway_url: "http://127.0.0.1:9" });
    const denied = await captureCli(["--profile", "gw", "desktop", "status"], {
      configDir: configDir2,
      env: {},
      skillsDir,
    });
    expect(denied.code).toBe(22);
  });
});

describe("desktop manager persist", () => {
  test("keep add writes 0600 daemon config without client Profile files", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-persist-"));
    const current = world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } });
    const io: DesktopIo = {
      readWorld: async () => current,
      stopWindow: async () => {},
      reapLogs: async () => {},
    };
    const manager = await DesktopManager.create(configDir, () => 2_000_000, { minIdleMs: 600_000 }, io);
    await manager.keepAdd(AGENT_A);
    const configPath = join(configDir, "daemon", "config.json");
    expect(((await import("node:fs")).statSync(configPath).mode & 0o777)).toBe(0o600);
    const persisted = JSON.parse(await readFile(configPath, "utf8")) as { desktop: { keepAgentIds: string[] } };
    expect(persisted.desktop.keepAgentIds).toEqual([AGENT_A]);
    await chmod(join(configDir, "daemon"), 0o700);
    await manager.close();
  });

  test("enabled tick prunes idle forks without a second process", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-tick-"));
    const stopped: number[] = [];
    const current = world({
      nowMs: 2_000_000,
      transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 },
    });
    const io: DesktopIo = {
      readWorld: async () => current,
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
    };
    const manager = await DesktopManager.create(
      configDir,
      () => 2_000_000,
      { minIdleMs: 600_000, floorAgentIds: [AGENT_KEEP], pruneEnabled: true },
      io,
      20,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stopped).toContain(2);
    expect(stopped).toContain(3);
    expect(stopped).not.toContain(10);
    await manager.close();
  });
});

describe("desktop keep id case canonicalization", () => {
  const UPPER_A = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";

  test("keep add with an uppercase raw uuid stores lowercase and protects the seated agent", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-case-add-"));
    const stopped: number[] = [];
    const idle = world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } });
    const io: DesktopIo = {
      readWorld: async () => idle,
      stopWindow: async (display) => { stopped.push(display); },
      reapLogs: async () => {},
    };
    const manager = await DesktopManager.create(configDir, () => 2_000_000, { minIdleMs: 600_000 }, io);

    const added = await manager.keepAdd(UPPER_A);
    expect(added).toEqual({ agentId: AGENT_A, kept: true });
    const persisted = await readDaemonConfig(configDir);
    expect(persisted.desktop?.keepAgentIds).toEqual([AGENT_A]);

    const plan = await manager.prune(false);
    expect(plan.rows.find((row) => row.display === 2)?.outcome).toBe("kept");
    expect(plan.rows.find((row) => row.display === 3)?.outcome).toBe("planned");

    const live = await manager.prune(true);
    expect(live.rows.find((row) => row.display === 2)?.outcome).toBe("kept");
    expect(live.rows.find((row) => row.display === 3)?.outcome).toBe("stopped");
    expect(stopped).not.toContain(2);
    expect(stopped).toContain(3);
    await manager.close();
  });

  test("keep remove succeeds regardless of supplied hex case", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-case-remove-"));
    const idle = world({ nowMs: 2_000_000, transcriptWrittenAtMs: { [AGENT_A]: 0, [AGENT_B]: 0, [AGENT_KEEP]: 0 } });
    const io: DesktopIo = {
      readWorld: async () => idle,
      stopWindow: async () => {},
      reapLogs: async () => {},
    };
    const manager = await DesktopManager.create(configDir, () => 2_000_000, { minIdleMs: 600_000 }, io);
    await manager.keepAdd(UPPER_A);
    expect((await manager.status()).keepAgentIds).toEqual([AGENT_A]);

    const removedLower = await manager.keepRemove(AGENT_A, true);
    expect(removedLower).toEqual({ agentId: AGENT_A, kept: false });
    expect((await manager.status()).keepAgentIds).toEqual([]);

    await manager.keepAdd(UPPER_A);
    const removedUpper = await manager.keepRemove(UPPER_A, true);
    expect(removedUpper).toEqual({ agentId: AGENT_A, kept: false });
    expect((await manager.status()).keepAgentIds).toEqual([]);

    const plan = await manager.prune(false);
    expect(plan.rows.find((row) => row.display === 2)?.outcome).toBe("planned");
    await manager.close();
  });

  test("config validation lowercases desktop keep/floor ids and rejects case-only duplicates", () => {
    const validated = validateDaemonConfig({
      version: 1,
      desktop: { keepAgentIds: [UPPER_A], floorAgentIds: [UPPER_A], minIdleMs: 600_000 },
    });
    expect(validated.desktop?.keepAgentIds).toEqual([AGENT_A]);
    expect(validated.desktop?.floorAgentIds).toEqual([AGENT_A]);

    expect(() => validateDaemonConfig({
      version: 1,
      desktop: { keepAgentIds: [UPPER_A, AGENT_A] },
    })).toThrow();
    expect(() => validateDaemonConfig({
      version: 1,
      desktop: { floorAgentIds: [UPPER_A, AGENT_A] },
    })).toThrow();
  });
});
