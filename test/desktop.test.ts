import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBoxLocalDesktopReap } from "../packages/cli/src/commands/agents.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { readDaemonConfig, validateDaemonConfig, writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import {
  DesktopManager,
  reapDeletedAgentSeat,
  unseatAgentFromAssignments,
  type DesktopIo,
} from "../packages/cli/src/daemon/desktop.ts";
import { startDaemonHost, type DaemonHost } from "../packages/cli/src/daemon/host.ts";
import {
  classifyDesktop,
  DEFAULT_MIN_IDLE_MS,
  displayFromEnviron,
  inspectDesktopProc,
  type DesktopWorld,
} from "../packages/cli/src/desktop.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery, type MockGateway } from "./helpers.ts";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const AGENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const AGENT_KEEP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_KEEP = "33333333-3333-4333-8333-333333333333";
const skillsDir = join(import.meta.dir, "..", "skills");

function dropAssignment(world: DesktopWorld, agentId: string): DesktopWorld {
  const query = agentId.toLowerCase();
  return {
    ...world,
    assignments: Object.fromEntries(
      Object.entries(world.assignments).filter(([id]) => id.toLowerCase() !== query),
    ),
  };
}

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

  async function harness(current: { value: DesktopWorld }, stopped: number[] = [], agents?: unknown[]) {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-desktop-"));
    const socket = join(configDir, "run", "daemon.sock");
    gateway = await startMockGateway(agents ? { agents } : undefined);
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
      unseatAgent: async (agentId) => {
        current.value = dropAssignment(current.value, agentId);
      },
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
      unseatAgent: async () => {},
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

  test("confirmed agent delete stops that bot's fork via stop-window", async () => {
    const stopped: number[] = [];
    const current = { value: world() };
    const { run } = await harness(current, stopped, [{
      id: AGENT_B,
      name: "idle-bot",
      title: "",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      memberIds: [],
    }]);
    const result = await run(["--profile", "daemon", "agents", "delete", "idle-bot", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(stopped).toEqual([3]);
    expect(current.value.assignments).toEqual({ [AGENT_A]: 2, [AGENT_KEEP]: 10 });
    const body = parseJson(result.stdout) as {
      data: { deleted: { id: string }; desktop: { display: number; outcome: string } };
    };
    expect(body.data.deleted.id).toBe(AGENT_B);
    expect(body.data.desktop).toEqual({ display: 3, outcome: "stopped" });
    expect(gateway?.requests.some((request) => request.pathname === "/api/deleteAgent")).toBe(true);
    const status = await run(["--profile", "daemon", "desktop", "status"]);
    expect(status.code).toBe(0);
    const seats = parseJson(status.stdout) as { data: { displays: Array<{ agentId: string }> } };
    expect(seats.data.displays.map((row) => row.agentId).sort()).toEqual([AGENT_A, AGENT_KEEP].sort());
  });

  test("unseated agent delete reports no_seat and leaves the table alone", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_A]: 2, [AGENT_KEEP]: 10 } }) };
    const { run } = await harness(current, stopped, [{
      id: AGENT_B,
      name: "idle-bot",
      title: "",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      memberIds: [],
    }]);
    const result = await run(["--profile", "daemon", "agents", "delete", "idle-bot", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(stopped).toEqual([]);
    expect(current.value.assignments).toEqual({ [AGENT_A]: 2, [AGENT_KEEP]: 10 });
    const body = parseJson(result.stdout) as { data: { desktop: { display: null; outcome: string } } };
    expect(body.data.desktop).toEqual({ display: null, outcome: "no_seat" });
  });

  test("main-display seat is not stopped or removed", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_B]: 1, [AGENT_A]: 2, [AGENT_KEEP]: 10 } }) };
    const { run } = await harness(current, stopped, [{
      id: AGENT_B,
      name: "idle-bot",
      title: "",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      memberIds: [],
    }]);
    const result = await run(["--profile", "daemon", "agents", "delete", "idle-bot", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(stopped).toEqual([]);
    expect(current.value.assignments).toEqual({ [AGENT_B]: 1, [AGENT_A]: 2, [AGENT_KEEP]: 10 });
    const body = parseJson(result.stdout) as { data: { desktop: { display: number; outcome: string } } };
    expect(body.data.desktop).toEqual({ display: 1, outcome: "skipped_main" });
    const status = await run(["--profile", "daemon", "desktop", "status"]);
    const seats = parseJson(status.stdout) as { data: { displays: Array<{ agentId: string; display: number }> } };
    expect(seats.data.displays.find((row) => row.agentId === AGENT_B)).toMatchObject({ display: 1 });
  });

  test("transport auto still attaches desktop when delete goes through the local daemon", async () => {
    const stopped: number[] = [];
    const current = { value: world() };
    const { configDir, run } = await harness(current, stopped, [{
      id: AGENT_B,
      name: "idle-bot",
      title: "",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      memberIds: [],
    }]);
    await writeProfileFile(configDir, "auto", {
      version: 1,
      transport: "auto",
      daemon_socket: join(configDir, "run", "daemon.sock"),
    });
    const result = await run(["--profile", "auto", "agents", "delete", "idle-bot", "--yes", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { deleted: { id: string }; desktop: { display: number; outcome: string } };
    };
    expect(body.data.deleted.id).toBe(AGENT_B);
    expect(body.data.desktop).toEqual({ display: 3, outcome: "stopped" });
    expect(stopped).toEqual([3]);
    expect(current.value.assignments).toEqual({ [AGENT_A]: 2, [AGENT_KEEP]: 10 });
  });
});

describe("deleted-bot desktop reap", () => {
  test("stops fork seats, skips the main desktop, and ignores non-UUIDs", async () => {
    const stopped: number[] = [];
    const unseated: string[] = [];
    const seated = { value: world({ assignments: { [AGENT_A]: 1, [AGENT_B]: 3 } }) };
    const io: DesktopIo = {
      readWorld: async () => seated.value,
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
      unseatAgent: async (agentId) => {
        unseated.push(agentId);
        seated.value = dropAssignment(seated.value, agentId);
      },
    };
    expect(await reapDeletedAgentSeat(AGENT_A, 1, io)).toEqual({ display: 1, outcome: "skipped_main" });
    expect(seated.value.assignments).toEqual({ [AGENT_A]: 1, [AGENT_B]: 3 });
    expect(await reapDeletedAgentSeat(AGENT_B, 1, io)).toEqual({ display: 3, outcome: "stopped" });
    expect(await reapDeletedAgentSeat("not-a-bot", 1, io)).toEqual({ display: null, outcome: "no_seat" });
    expect(stopped).toEqual([3]);
    expect(unseated).toEqual([AGENT_B]);
    expect(seated.value.assignments).toEqual({ [AGENT_A]: 1 });
  });

  test("unseated delete reports no_seat without touching the table", async () => {
    const stopped: number[] = [];
    const unseated: string[] = [];
    const seated = { value: world({ assignments: { [AGENT_A]: 2 } }) };
    const io: DesktopIo = {
      readWorld: async () => seated.value,
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
      unseatAgent: async (agentId) => {
        unseated.push(agentId);
        seated.value = dropAssignment(seated.value, agentId);
      },
    };
    expect(await reapDeletedAgentSeat(AGENT_B, 1, io)).toEqual({ display: null, outcome: "no_seat" });
    expect(stopped).toEqual([]);
    expect(unseated).toEqual([]);
    expect(seated.value.assignments).toEqual({ [AGENT_A]: 2 });
  });

  test("stop-window success then unseat failure is unavailable, not silent", async () => {
    const stopped: number[] = [];
    const io: DesktopIo = {
      readWorld: async () => world({ assignments: { [AGENT_B]: 3 } }),
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
      unseatAgent: async () => {
        throw new Error("seat table locked");
      },
    };
    expect(await reapDeletedAgentSeat(AGENT_B, 1, io)).toEqual({ display: 3, outcome: "unavailable" });
    expect(stopped).toEqual([3]);
  });

  test("atomically drops one agent from assignments and tokens and preserves the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-seat-table-"));
    const path = join(dir, ".sand-window-assignments.json");
    await writeFile(path, `${JSON.stringify({
      assignments: { [AGENT_A]: 1, [AGENT_B]: 3, [AGENT_KEEP]: 10 },
      tokens: { [AGENT_A]: TOKEN_A, [AGENT_B]: TOKEN_B, [AGENT_KEEP]: TOKEN_KEEP },
      extra: { keep: true },
    }, null, 2)}\n`, { mode: 0o644 });
    await unseatAgentFromAssignments(path, AGENT_B.toUpperCase());
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      assignments: Record<string, number>;
      tokens: Record<string, string>;
      extra: { keep: boolean };
    };
    expect(parsed.assignments).toEqual({ [AGENT_A]: 1, [AGENT_KEEP]: 10 });
    expect(parsed.tokens).toEqual({ [AGENT_A]: TOKEN_A, [AGENT_KEEP]: TOKEN_KEEP });
    expect(parsed.extra).toEqual({ keep: true });
    expect(JSON.stringify(parsed)).not.toContain(AGENT_B);
    expect(JSON.stringify(parsed)).not.toContain(TOKEN_B);
  });

  test("corrupt seating JSON is left untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-seat-corrupt-"));
    const path = join(dir, ".sand-window-assignments.json");
    await writeFile(path, "{not-json", { mode: 0o644 });
    await expect(unseatAgentFromAssignments(path, AGENT_B)).rejects.toMatchObject({ code: "desktop_unavailable" });
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  test("missing seating file is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-seat-missing-"));
    await unseatAgentFromAssignments(join(dir, ".sand-window-assignments.json"), AGENT_B);
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
      unseatAgent: async () => {},
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
      unseatAgent: async () => {},
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
      unseatAgent: async () => {},
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
      unseatAgent: async () => {},
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

describe("AH-93 box-local transport auto desktop reap", () => {
  let gateway: MockGateway | undefined;

  afterEach(() => {
    gateway?.stop();
    gateway = undefined;
  });

  function idleBot() {
    return {
      id: AGENT_B,
      name: "idle-bot",
      title: "",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      memberIds: [],
    };
  }

  function seatedIo(current: { value: DesktopWorld }, stopped: number[]): DesktopIo {
    return {
      readWorld: async () => current.value,
      stopWindow: async (display) => {
        stopped.push(display);
      },
      reapLogs: async () => {},
      unseatAgent: async (agentId) => {
        current.value = dropAssignment(current.value, agentId);
      },
    };
  }

  async function deleteThroughProfile(
    profile: { transport: "auto" | "local"; ssh_host?: string; server_url?: string },
    io: DesktopIo,
  ) {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-ah93-"));
    gateway = await startMockGateway({ agents: [idleBot()] });
    const discoveryPath = await writeDiscovery({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: gateway.token,
    });
    await writeProfileFile(configDir, "box", {
      version: 1,
      ...profile,
      gateway_discovery: discoveryPath,
    });
    return await captureCli(["--profile", "box", "agents", "delete", "idle-bot", "--yes", "--json"], {
      configDir,
      env: {},
      discoveryPath,
      transport: "auto",
      desktopIo: io,
      skillsDir,
    });
  }

  test("gate treats auto like local and skips ssh or remote daemon URL", () => {
    expect(isBoxLocalDesktopReap({ transport: "auto" })).toBe(true);
    expect(isBoxLocalDesktopReap({ transport: "local" })).toBe(true);
    expect(isBoxLocalDesktopReap({ transport: "daemon" })).toBe(false);
    expect(isBoxLocalDesktopReap({ transport: "gateway" })).toBe(false);
    expect(isBoxLocalDesktopReap({ transport: "auto", sshHost: "peer" })).toBe(false);
    expect(isBoxLocalDesktopReap({ transport: "auto", daemonServerUrl: "https://daemon.example" })).toBe(false);
    expect(isBoxLocalDesktopReap({ transport: "local", sshHost: "peer" })).toBe(false);
    expect(isBoxLocalDesktopReap({
      transport: "local",
      daemonServerUrl: "https://daemon.example",
    })).toBe(false);
  });

  test("transport auto delete reaps a non-main seat and includes desktop on the receipt", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_A]: 2, [AGENT_B]: 27 } }) };
    const result = await deleteThroughProfile({ transport: "auto" }, seatedIo(current, stopped));
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { deleted: { id: string }; desktop: { display: number | null; outcome: string } };
    };
    expect(body.data.deleted.id).toBe(AGENT_B);
    expect(body.data.desktop).toEqual({ display: 27, outcome: "stopped" });
    expect(stopped).toEqual([27]);
    expect(current.value.assignments).toEqual({ [AGENT_A]: 2 });
  });

  test("transport local delete still reaps when no daemon attached desktop", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_B]: 27 } }) };
    const result = await deleteThroughProfile({ transport: "local" }, seatedIo(current, stopped));
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as { data: { desktop: { display: number; outcome: string } } };
    expect(body.data.desktop).toEqual({ display: 27, outcome: "stopped" });
    expect(stopped).toEqual([27]);
    expect(current.value.assignments).toEqual({});
  });

  test("auto plus ssh_host does not mutate this box's seat table", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_B]: 27 } }) };
    const result = await deleteThroughProfile(
      { transport: "auto", ssh_host: "peer" },
      seatedIo(current, stopped),
    );
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as { data: { desktop?: unknown } };
    expect(body.data.desktop).toBeUndefined();
    expect(stopped).toEqual([]);
    expect(current.value.assignments).toEqual({ [AGENT_B]: 27 });
  });

  test("auto plus remote daemon URL does not mutate this box's seat table", async () => {
    const stopped: number[] = [];
    const current = { value: world({ assignments: { [AGENT_B]: 27 } }) };
    const result = await deleteThroughProfile(
      { transport: "auto", server_url: "https://daemon.example" },
      seatedIo(current, stopped),
    );
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as { data: { desktop?: unknown } };
    expect(body.data.desktop).toBeUndefined();
    expect(stopped).toEqual([]);
    expect(current.value.assignments).toEqual({ [AGENT_B]: 27 });
  });
});
