import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import { startDaemonHost } from "../src/daemon/host.ts";
import { createProductionDeps, type CliDeps } from "../src/deps.ts";
import {
  captureCli,
  parseJson,
  rpcCalls,
  sampleAgents,
  startMockGateway,
  writeDiscovery,
  type MockGateway,
} from "./helpers.ts";

const BOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMPORAL_BOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OP = "routine-op-1";
const PRIVATE_PROMPT = "PRIVATE routine body that must never appear in output";

function botRow() {
  return {
    id: BOT,
    name: "routine-bot",
    title: "Routine Bot",
    description: "fixture",
    isGroup: false,
    isHiddenFromSidebar: false,
    isRunning: false,
    isRunningTurn: false,
    awaitingUserResponse: false,
    hasUnread: false,
    updatedAt: 1,
    memberIds: [],
  };
}

function temporalBotRow() {
  return {
    ...botRow(),
    id: TEMPORAL_BOT,
    name: "temporal-routine-bot",
    title: "Temporal Routine Bot",
    harness: "temporal",
  };
}

function seedRoutine() {
  return {
    id: "seed-routine",
    name: "Seed",
    prompt: "PRIVATE_SEED_PROMPT",
    trigger: { type: "webhook" },
    isEnabled: true,
    createdAt: 10,
    lastRunAt: null,
    nextRunAt: null,
    filePath: "/PRIVATE/native/routine.json",
    credential: "PRIVATE_CREDENTIAL",
  };
}

async function fixture() {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-routines-test-"));
  const socket = join(configDir, "run", "daemon.sock");
  const gateway = await startMockGateway({
    agents: [...sampleAgents(), botRow()],
    routines: { [BOT]: [seedRoutine()] },
  });
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const base: Partial<CliDeps> = {
    configDir,
    env: {},
    discoveryPath,
    daemonSocket: socket,
    transport: "auto",
    stdinIsTTY: true,
    confirm: async () => false,
    randomUUID: () => OP,
  };
  const run = async (argv: string[], overrides: Partial<CliDeps> = {}) =>
    await captureCli(argv, { ...base, ...overrides });
  return { configDir, socket, gateway, discoveryPath, run };
}

async function temporalFixture(routines: unknown[] = [seedRoutine()]) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-temporal-routines-test-"));
  const socket = join(configDir, "run", "daemon.sock");
  const gateway = await startMockGateway({
    agents: [...sampleAgents(), temporalBotRow()],
    routines: { [TEMPORAL_BOT]: routines },
    webhookCredential: {
      url: "https://example.test/automations/webhook/server-routine-id",
      key: "fixture-temporal-webhook-secret",
    },
  });
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const base: Partial<CliDeps> = {
    configDir,
    env: {},
    discoveryPath,
    daemonSocket: socket,
    transport: "auto",
    stdinIsTTY: true,
    confirm: async () => false,
    randomUUID: () => OP,
  };
  const run = async (argv: string[], overrides: Partial<CliDeps> = {}) =>
    await captureCli(argv, { ...base, ...overrides });
  return { configDir, socket, gateway, discoveryPath, run };
}

function body<T>(text: string): T {
  return (parseJson(text) as { data: T }).data;
}

function routineWriteCalls(gateway: MockGateway) {
  return gateway.requests.filter((request) => [
    "/api/createAgentAutomation",
    "/api/updateAgentAutomation",
    "/api/setAgentAutomationEnabled",
    "/api/deleteAgentAutomation",
  ].includes(request.pathname));
}

describe("native Routine management", () => {
  test("list/show expose bounded safe metadata without prompt, credential, or native path", async () => {
    const f = await fixture();
    try {
      const listed = await f.run(["agents", "routines", "list", "routine-bot"]);
      expect(listed.code).toBe(0);
      const data = body<{
        agentId: string;
        routines: Array<{
          id: string;
          name: string;
          enabled: boolean;
          trigger: { type: string };
          promptIncluded: boolean;
          credentialsIncluded: boolean;
          revision: string;
          definitionRevision: string;
        }>;
        coverage: { kind: string; limit: number; complete: boolean; atLimit: boolean };
      }>(listed.stdout);
      expect(data.agentId).toBe(BOT);
      expect(data.routines).toHaveLength(1);
      expect(data.routines[0]).toMatchObject({
        id: "seed-routine",
        name: "Seed",
        enabled: true,
        trigger: { type: "webhook" },
        promptIncluded: false,
        credentialsIncluded: false,
      });
      expect(data.routines[0]!.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(data.routines[0]!.definitionRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(data.coverage).toEqual({
        kind: "native_returned_window",
        limit: 100,
        atLimit: false,
        complete: false,
      });

      const shown = await f.run(["agents", "routines", "show", BOT, "seed-routine"]);
      expect(shown.code).toBe(0);
      expect(body<{ routine: { id: string } }>(shown.stdout).routine.id).toBe("seed-routine");

      const table = await f.run(["agents", "routines", "list", BOT, "--table"]);
      expect(table.code).toBe(0);
      expect(table.stdout).toContain("seed-routine");
      expect(table.stdout).toContain("webhook");

      const allOutput = listed.stdout + shown.stdout + table.stdout;
      expect(allOutput).not.toContain("PRIVATE");
      expect(allOutput).not.toContain("PRIVATE_CREDENTIAL");
      expect(allOutput).not.toContain("/PRIVATE/native/routine.json");
      expect(rpcCalls(f.gateway.requests, "getAgentAutomations").length).toBeGreaterThanOrEqual(3);
      expect(routineWriteCalls(f.gateway)).toHaveLength(0);
    } finally {
      f.gateway.stop();
    }
  });

  test("create/update/enable/disable/delete complete one native Routine lifecycle with readback", async () => {
    const f = await fixture();
    try {
      const created = await f.run([
        "agents", "routines", "create", "routine-bot",
        "--name", "Owned",
        "--text", PRIVATE_PROMPT,
        "--webhook",
        "--operation-id", OP,
        "--confirm",
      ]);
      expect(created.code).toBe(0);
      expect(created.stdout).not.toContain(PRIVATE_PROMPT);
      const createdData = body<{
        receipt: { state: string; routineId: string; afterRevision: string };
        routine: { id: string; enabled: boolean; revision: string; trigger: { type: string } };
      }>(created.stdout);
      expect(createdData.receipt.state).toBe("disabled_definition_observed");
      expect(createdData.receipt.routineId).toBe("routine-created-1");
      expect(createdData.routine).toMatchObject({
        id: "routine-created-1",
        enabled: false,
        trigger: { type: "webhook" },
      });
      const rawCreated = f.gateway.routines.get(BOT)?.find((row) => row.id === "routine-created-1");
      expect(rawCreated).toMatchObject({ prompt: PRIVATE_PROMPT, isEnabled: false });

      const enabled = await f.run([
        "agents", "routines", "enable", "routine-bot", "routine-created-1",
        "--expect-revision", createdData.routine.revision,
        "--operation-id", "routine-enable-1",
        "--confirm",
      ]);
      expect(enabled.code).toBe(0);
      const enabledData = body<{
        receipt: { state: string; afterRevision: string };
        routine: { enabled: boolean; revision: string };
      }>(enabled.stdout);
      expect(enabledData.receipt.state).toBe("requested_state_observed");
      expect(enabledData.routine.enabled).toBe(true);

      const updated = await f.run([
        "agents", "routines", "update", "routine-bot", "routine-created-1",
        "--name", "Owned daily",
        "--text", "PRIVATE updated routine prompt",
        "--cron", "0 8 * * *",
        "--expect-revision", enabledData.routine.revision,
        "--operation-id", "routine-update-1",
        "--confirm",
      ]);
      expect(updated.code).toBe(0);
      expect(updated.stdout).not.toContain("PRIVATE updated routine prompt");
      const updatedData = body<{
        receipt: { state: string; beforeRevision: string; afterRevision: string };
        routine: { enabled: boolean; revision: string; name: string; trigger: { type: string; schedule: string } };
      }>(updated.stdout);
      expect(updatedData.receipt.state).toBe("definition_observed");
      expect(updatedData.routine).toMatchObject({
        name: "Owned daily",
        enabled: true,
        trigger: { type: "cron", schedule: "0 8 * * *" },
      });
      expect(f.gateway.routines.get(BOT)?.find((row) => row.id === "routine-created-1")).toMatchObject({
        prompt: "PRIVATE updated routine prompt",
        isEnabled: true,
      });

      const disabled = await f.run([
        "agents", "routines", "disable", BOT, "routine-created-1",
        "--expect-revision", updatedData.routine.revision,
        "--operation-id", "routine-disable-1",
        "--confirm",
      ]);
      expect(disabled.code).toBe(0);
      const disabledData = body<{
        routine: { enabled: boolean; revision: string };
      }>(disabled.stdout);
      expect(disabledData.routine.enabled).toBe(false);

      const removed = await f.run([
        "agents", "routines", "delete", BOT, "routine-created-1",
        "--expect-revision", disabledData.routine.revision,
        "--operation-id", "routine-delete-1",
        "--confirm",
      ]);
      expect(removed.code).toBe(0);
      expect(body<{ receipt: { state: string; afterRevision: null } }>(removed.stdout).receipt)
        .toMatchObject({ state: "absent_in_returned_window", afterRevision: null });
      expect(f.gateway.routines.get(BOT)?.some((row) => row.id === "routine-created-1")).toBe(false);

      expect(routineWriteCalls(f.gateway).map((request) => request.pathname)).toEqual([
        "/api/createAgentAutomation",
        "/api/setAgentAutomationEnabled",
        "/api/updateAgentAutomation",
        "/api/setAgentAutomationEnabled",
        "/api/deleteAgentAutomation",
      ]);
      const update = rpcCalls(f.gateway.requests, "updateAgentAutomation")[0]!;
      expect(update.body).toEqual({
        id: BOT,
        automationId: "routine-created-1",
        spec: {
          name: "Owned daily",
          prompt: "PRIVATE updated routine prompt",
          trigger: { type: "cron", schedule: "0 8 * * *" },
        },
      });
      expect((update.body as { spec: Record<string, unknown> }).spec).not.toHaveProperty("isEnabled");
    } finally {
      f.gateway.stop();
    }
  });

  test("revision and confirmation checks stop before any native write", async () => {
    const f = await fixture();
    try {
      const shown = await f.run(["agents", "routines", "show", BOT, "seed-routine"]);
      const revision = body<{ routine: { revision: string } }>(shown.stdout).routine.revision;

      const noConfirm = await f.run([
        "agents", "routines", "disable", BOT, "seed-routine",
        "--expect-revision", revision,
      ]);
      expect(noConfirm.code).toBe(2);

      const conflict = await f.run([
        "agents", "routines", "disable", BOT, "seed-routine",
        "--expect-revision", "0".repeat(64),
        "--confirm",
      ]);
      expect(conflict.code).toBe(14);
      expect(routineWriteCalls(f.gateway)).toHaveLength(0);

      const invalidTrigger = await f.run([
        "agents", "routines", "create", BOT,
        "--name", "Invalid",
        "--text", "body",
        "--webhook",
        "--cron", "* * * * *",
        "--confirm",
      ]);
      expect(invalidTrigger.code).toBe(2);
      expect(routineWriteCalls(f.gateway)).toHaveLength(0);
    } finally {
      f.gateway.stop();
    }
  });

  test("a lost native write response is unknown and is not replayed", async () => {
    const f = await fixture();
    let writes = 0;
    const fetchWithLostWrite = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/setAgentAutomationEnabled")) {
        writes += 1;
        throw new TypeError("simulated connection loss");
      }
      return await globalThis.fetch(input, init);
    }) as typeof fetch;
    try {
      await writeProfileFile(f.configDir, "direct", {
        version: 1,
        transport: "local",
        gateway_discovery: f.discoveryPath,
      });
      const shown = await f.run(["--profile", "direct", "agents", "routines", "show", BOT, "seed-routine"]);
      const revision = body<{ routine: { revision: string } }>(shown.stdout).routine.revision;
      const result = await f.run([
        "--profile", "direct",
        "agents", "routines", "disable", BOT, "seed-routine",
        "--expect-revision", revision,
        "--operation-id", "lost-routine-write",
        "--confirm",
      ], { fetch: fetchWithLostWrite });
      expect(result.code).toBe(28);
      const error = parseJson(result.stderr) as {
        error: { code: string; context?: { operationId?: string; phase?: string } };
      };
      expect(error.error.code).toBe("operation_outcome_unknown");
      expect(error.error.context).toMatchObject({
        operationId: "lost-routine-write",
        phase: "native-routine",
      });
      expect(writes).toBe(1);
    } finally {
      f.gateway.stop();
    }
  });

  test("Temporal routines use Server authority, expose webhook credentials safely, and refuse unsupported definition writes", async () => {
    const f = await temporalFixture();
    try {
      const listed = await f.run(["agents", "routines", "list", TEMPORAL_BOT]);
      expect(listed.code, listed.stderr).toBe(0);
      const listedData = body<{
        authority: string;
        routines: Array<{ id: string; trigger: { type: string } }>;
      }>(listed.stdout);
      expect(listedData.authority).toBe("server-temporal");
      expect(listedData.routines).toHaveLength(1);

      const hidden = await f.run([
        "agents", "routines", "webhook", "credential",
        TEMPORAL_BOT, "seed-routine",
        "--confirm",
      ]);
      expect(hidden.code, hidden.stderr).toBe(0);
      const hiddenData = body<{
        authority: string;
        url: string;
        keyPresent: boolean;
        keyIncluded: boolean;
        key?: string;
      }>(hidden.stdout);
      expect(hiddenData).toMatchObject({
        authority: "server-temporal",
        url: "https://example.test/automations/webhook/server-routine-id",
        keyPresent: true,
        keyIncluded: false,
      });
      expect(hiddenData.key).toBeUndefined();
      expect(hidden.stdout).not.toContain("fixture-temporal-webhook-secret");
      expect(hidden.stdout).not.toContain("PRIVATE_SEED_PROMPT");
      expect(body<{ promptIncluded: boolean; prompt?: string }>(hidden.stdout).promptIncluded).toBe(false);

      const revealed = await f.run([
        "agents", "routines", "webhook", "credential",
        TEMPORAL_BOT, "seed-routine",
        "--confirm",
        "--reveal-key",
      ]);
      expect(revealed.code, revealed.stderr).toBe(0);
      expect(body<{ keyIncluded: boolean; key: string; promptIncluded: boolean; prompt: string }>(revealed.stdout)).toMatchObject({
        keyIncluded: true,
        promptIncluded: true,
        key: "fixture-temporal-webhook-secret",
        prompt: "PRIVATE_SEED_PROMPT",
      });

      const noConfirm = await f.run([
        "agents", "routines", "webhook", "credential",
        TEMPORAL_BOT, "seed-routine",
      ]);
      expect(noConfirm.code).toBe(2);

      const beforeWrites = routineWriteCalls(f.gateway).length;
      const create = await f.run([
        "agents", "routines", "create", TEMPORAL_BOT,
        "--name", "Unsupported",
        "--text", "body",
        "--webhook",
        "--confirm",
      ]);
      expect(create.code).not.toBe(0);
      expect(parseJson(create.stderr)).toMatchObject({
        error: { code: "capability_unavailable" },
      });
      expect(create.stderr).toContain("does not expose create");

      const shown = await f.run(["agents", "routines", "show", TEMPORAL_BOT, "seed-routine"]);
      const revision = body<{ routine: { revision: string } }>(shown.stdout).routine.revision;
      const update = await f.run([
        "agents", "routines", "update", TEMPORAL_BOT, "seed-routine",
        "--name", "Unsupported",
        "--text", "body",
        "--webhook",
        "--expect-revision", revision,
        "--confirm",
      ]);
      expect(update.code).not.toBe(0);
      expect(parseJson(update.stderr)).toMatchObject({
        error: { code: "capability_unavailable" },
      });
      expect(update.stderr).toContain("does not expose definition update");
      expect(routineWriteCalls(f.gateway)).toHaveLength(beforeWrites);
    } finally {
      f.gateway.stop();
    }
  });

  test("direct and daemon transports expose the same Routine read/write behavior", async () => {
    const f = await fixture();
    const hostDeps = {
      ...createProductionDeps(),
      configDir: f.configDir,
      env: {},
      discoveryPath: f.discoveryPath,
      daemonSocket: f.socket,
      transport: "local" as const,
    };
    const host = await startDaemonHost(hostDeps, f.socket);
    try {
      await writeProfileFile(f.configDir, "direct", {
        version: 1,
        transport: "local",
        gateway_discovery: f.discoveryPath,
      });
      await writeProfileFile(f.configDir, "daemon", {
        version: 1,
        transport: "daemon",
        daemon_socket: f.socket,
        gateway_discovery: f.discoveryPath,
      });

      const direct = await f.run(["--profile", "direct", "agents", "routines", "show", BOT, "seed-routine"]);
      const daemon = await f.run(["--profile", "daemon", "agents", "routines", "show", BOT, "seed-routine"]);
      expect(direct.code).toBe(0);
      expect(daemon.code).toBe(0);
      expect(body<unknown>(daemon.stdout)).toEqual(body<unknown>(direct.stdout));

      const revision = body<{ routine: { revision: string } }>(daemon.stdout).routine.revision;
      const changed = await f.run([
        "--profile", "daemon",
        "agents", "routines", "disable", BOT, "seed-routine",
        "--expect-revision", revision,
        "--operation-id", "daemon-routine-disable",
        "--confirm",
      ]);
      expect(changed.code).toBe(0);
      expect(body<{ routine: { enabled: boolean } }>(changed.stdout).routine.enabled).toBe(false);
    } finally {
      await host.close();
      f.gateway.stop();
    }
  });
});
