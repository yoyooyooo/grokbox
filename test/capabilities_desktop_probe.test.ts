import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { DesktopManager, type DesktopIo } from "../packages/cli/src/daemon/desktop.ts";
import { startDaemonHost, type DaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import type { DesktopWorld } from "../packages/cli/src/desktop.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery, type MockGateway } from "./helpers.ts";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const skillsDir = join(import.meta.dir, "..", "skills");

function world(): DesktopWorld {
  return {
    nowMs: 2_000_000,
    assignments: { [AGENT_A]: 2 },
    names: { [AGENT_A]: "research" },
    litDisplays: new Set([2]),
    displayStartedAtMs: { 2: 0 },
    transcriptWrittenAtMs: { [AGENT_A]: 2_000_000 },
    busyMarkers: new Set(),
    grokDisplays: new Set(),
    taskDisplays: new Set(),
    startWindowDisplays: new Set(),
  };
}

describe("profile capabilities vs desktop probe", () => {
  let host: DaemonHost | undefined;
  let gateway: MockGateway | undefined;

  afterEach(async () => {
    await host?.close().catch(() => undefined);
    gateway?.stop();
    host = undefined;
    gateway = undefined;
  });

  test("auto profile reports host.desktop.read when desktop status is readable", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-cap-desktop-up-"));
    const socket = join(configDir, "run", "daemon.sock");
    gateway = await startMockGateway();
    const discoveryPath = await writeDiscovery({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: gateway.token,
    });
    const io: DesktopIo = {
      readWorld: async () => world(),
      stopWindow: async () => {},
      reapLogs: async () => {},
      unseatAgent: async () => {},
    };
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      discoveryPath,
      daemonSocket: socket,
      transport: "local" as const,
    };
    host = await startDaemonHost(deps, socket, undefined, [], { minIdleMs: 600_000 }, io);
    await writeProfileFile(configDir, "auto-box", {
      version: 1,
      transport: "auto",
      daemon_socket: socket,
      gateway_discovery: discoveryPath,
    });
    const run = async (argv: string[]) =>
      await captureCli(argv, {
        configDir,
        env: {},
        discoveryPath: "/must-not-be-used.json",
        daemonSocket: join(configDir, "unused.sock"),
        transport: "auto",
        skillsDir,
      });

    const status = await run(["--profile", "auto-box", "desktop", "status"]);
    expect(status.code, status.stderr).toBe(0);
    const statusBody = parseJson(status.stdout) as { data: { displays: unknown[] } };
    expect(Array.isArray(statusBody.data.displays)).toBe(true);

    const capabilities = await run(["profile", "capabilities", "auto-box"]);
    expect(capabilities.code, capabilities.stderr).toBe(0);
    const body = parseJson(capabilities.stdout) as {
      data: { capabilities: Record<string, boolean | string> };
    };
    expect(body.data.capabilities["host.desktop.read"]).toBe(true);
    expect(body.data.capabilities["host.desktop.reap"]).toBe(true);
  });

  test("auto profile keeps host.desktop.read false when the local daemon is down", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-cap-desktop-down-"));
    const socket = join(configDir, "run", "missing.sock");
    await writeProfileFile(configDir, "auto-box", {
      version: 1,
      transport: "auto",
      daemon_socket: socket,
    });
    const run = async (argv: string[]) =>
      await captureCli(argv, {
        configDir,
        env: {},
        discoveryPath: "/missing/gateway.json",
        daemonSocket: socket,
        transport: "auto",
        skillsDir,
      });

    const capabilities = await run(["profile", "capabilities", "auto-box"]);
    expect(capabilities.code, capabilities.stderr).toBe(0);
    const body = parseJson(capabilities.stdout) as {
      data: { capabilities: Record<string, boolean | string> };
    };
    expect(body.data.capabilities["host.desktop.read"]).toBe(false);
    expect(body.data.capabilities["host.desktop.reap"]).toBe(false);

    const status = await run(["--profile", "auto-box", "desktop", "status"]);
    expect(status.code).toBe(26);
    const error = parseJson(status.stderr) as { error: { code: string; next?: string } };
    expect(error.error.code).toBe("daemon_unreachable");
    expect(error.error.next).toBe("grokbox on");
  });

  test("live handshake without reap stays coherent with desktop status", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-cap-desktop-read-only-"));
    const socket = join(configDir, "run", "daemon.sock");
    gateway = await startMockGateway();
    const discoveryPath = await writeDiscovery({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: gateway.startedAt,
      token: gateway.token,
    });
    const deps = {
      ...createProductionDeps(),
      configDir,
      env: {},
      discoveryPath,
      daemonSocket: socket,
      transport: "local" as const,
    };
    // No DesktopIo and no pinable stop-window => host.desktop.read only.
    host = await startDaemonHost(deps, socket, undefined, [], {
      minIdleMs: 600_000,
      stopWindowPath: join(configDir, "missing-stop-window"),
    });
    await writeProfileFile(configDir, "auto-box", {
      version: 1,
      transport: "auto",
      daemon_socket: socket,
      gateway_discovery: discoveryPath,
    });
    const manager = await DesktopManager.create(
      configDir,
      () => 2_000_000,
      { minIdleMs: 600_000, stopWindowPath: join(configDir, "missing-stop-window") },
    );
    expect(manager.canReap).toBe(false);
    expect(manager.capabilities()).toEqual(["host.desktop.read"]);
    await manager.close();

    const result = await captureCli(["profile", "capabilities", "auto-box"], {
      configDir,
      env: {},
      discoveryPath: "/must-not-be-used.json",
      daemonSocket: join(configDir, "unused.sock"),
      transport: "auto",
      skillsDir,
    });
    expect(result.code, result.stderr).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { capabilities: Record<string, boolean | string> };
    };
    expect(body.data.capabilities["host.desktop.read"]).toBe(true);
    expect(body.data.capabilities["host.desktop.reap"]).toBe(false);
  });
});
