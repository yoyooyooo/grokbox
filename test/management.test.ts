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
  sampleAgents,
  startMockGateway,
  writeDiscovery,
  type MockGateway,
} from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const writePaths = new Set([
  "/api/createAgent",
  "/api/createGroup",
  "/api/updateAgent",
  "/api/setGroupMembers",
  "/api/setAgentNotifyOnUpdates",
  "/api/setAgentHiddenFromSidebar",
  "/api/deleteAgent",
]);

function extraAgent(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    title: "",
    description: `${name} profile`,
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

async function fixture(agents?: unknown[]) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-management-test-"));
  const socket = join(configDir, "run", "daemon.sock");
  const gateway = await startMockGateway({ agents });
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
    skillsDir,
    stdinIsTTY: true,
    confirm: async () => false,
    randomUUID: () => nonce,
  };
  const run = async (argv: string[], overrides: Partial<CliDeps> = {}) =>
    await captureCli(argv, { ...base, ...overrides });
  return { configDir, discoveryPath, gateway, run, socket };
}

function managementRequests(gateway: MockGateway) {
  return gateway.requests.filter((request) => writePaths.has(request.pathname));
}

describe("agent and group management", () => {
  test("agent create, full-profile update, and confirmed delete use typed Gateway methods", async () => {
    const f = await fixture();
    try {
      const created = await f.run([
        "agents", "create",
        "--name", "Ada",
        "--instructions", "Build reliable systems",
        "--title", "Engineer",
        "--avatar-shape", "square",
        "--avatar-color", "red",
        "--notify", "on",
        "--hidden", "off",
        "--nonce", nonce,
      ]);
      expect(created.code).toBe(0);
      const createdBody = parseJson(created.stdout) as {
        data: {
          agent: {
            id: string;
            kind: string;
            avatarShape: string | null;
            avatarColor: string | null;
            notifyOnUpdates: boolean;
          };
        };
      };
      expect(createdBody.data.agent).toMatchObject({
        id: "agent-created-1",
        kind: "agent",
        avatarShape: "square",
        avatarColor: "red",
        notifyOnUpdates: true,
      });
      expect(managementRequests(f.gateway).map((request) => request.pathname)).toEqual([
        "/api/createAgent",
        "/api/setAgentNotifyOnUpdates",
        "/api/setAgentHiddenFromSidebar",
      ]);
      expect(managementRequests(f.gateway)[0]?.body).toEqual({
        name: "Ada",
        description: "Build reliable systems",
        title: "Engineer",
        avatarShape: "square",
        avatarColor: "red",
        clientNonce: nonce,
      });

      const updated = await f.run([
        "agents", "update", "Ada",
        "--name", "Ada Prime",
        "--description", "Own the control plane",
        "--hidden", "on",
      ]);
      expect(updated.code).toBe(0);
      expect((parseJson(updated.stdout) as { data: { agent: { name: string; isHidden: boolean } } }).data.agent)
        .toMatchObject({ name: "Ada Prime", isHidden: true });
      const updates = managementRequests(f.gateway).filter((request) => request.pathname === "/api/updateAgent");
      const update = [...updates].reverse().find((request) => request.pathname === "/api/updateAgent");
      expect(update?.body).toEqual({
        id: "agent-created-1",
        profile: {
          name: "Ada Prime",
          description: "Own the control plane",
          title: "Engineer",
          avatarShape: "square",
          avatarColor: "red",
        },
      });

      const refused = await f.run(
        ["agents", "delete", "Ada Prime"],
        { stdinIsTTY: false },
      );
      expect(refused.code).toBe(2);
      expect(managementRequests(f.gateway).filter((request) => request.pathname === "/api/deleteAgent")).toHaveLength(0);

      const deleted = await f.run(["agents", "delete", "Ada Prime", "--yes"], { stdinIsTTY: false });
      expect(deleted.code).toBe(0);
      expect((parseJson(deleted.stdout) as {
        data: { deleted: { id: string; name: string; kind: string } };
      }).data.deleted).toEqual({ id: "agent-created-1", name: "Ada Prime", kind: "agent" });
      expect(managementRequests(f.gateway).at(-1)?.body).toEqual({ id: "agent-created-1" });
    } finally {
      f.gateway.stop();
    }
  });

  test("group lifecycle and hierarchical membership converge through setGroupMembers", async () => {
    const agents = [...sampleAgents(), extraAgent("agent-beta", "beta"), extraAgent("agent-gamma", "gamma")];
    const f = await fixture(agents);
    try {
      const created = await f.run([
        "groups", "create",
        "--name", "platform",
        "--member", "alpha", "beta",
        "--description", "Platform room",
        "--title", "Core",
      ]);
      expect(created.code).toBe(0);
      expect((parseJson(created.stdout) as { data: { group: { id: string; memberIds: string[] } } }).data.group)
        .toMatchObject({ id: "group-created-1", memberIds: ["agent-alpha", "agent-beta"] });
      expect(managementRequests(f.gateway)[0]?.body).toEqual({
        name: "platform",
        description: "Platform room",
        memberAgentIds: ["agent-alpha", "agent-beta"],
      });

      const added = await f.run(["groups", "members", "add", "platform", "gamma"]);
      expect(added.code).toBe(0);
      expect((parseJson(added.stdout) as { data: { members: Array<{ id: string }> } }).data.members.map((row) => row.id))
        .toEqual(["agent-alpha", "agent-beta", "agent-gamma"]);

      const removed = await f.run(["groups", "members", "remove", "platform", "beta"]);
      expect(removed.code).toBe(0);
      const set = await f.run(["groups", "members", "set", "platform", "--member", "beta", "alpha"]);
      expect(set.code).toBe(0);
      expect((parseJson(set.stdout) as { data: { members: Array<{ id: string }> } }).data.members.map((row) => row.id))
        .toEqual(["agent-beta", "agent-alpha"]);

      const updated = await f.run(["groups", "update", "platform", "--name", "platform-core", "--hidden", "on"]);
      expect(updated.code).toBe(0);
      expect((parseJson(updated.stdout) as { data: { group: { name: string; isHidden: boolean } } }).data.group)
        .toMatchObject({ name: "platform-core", isHidden: true });

      const deleted = await f.run(["groups", "delete", "platform-core", "--yes"]);
      expect(deleted.code).toBe(0);
      expect(managementRequests(f.gateway).filter((request) => request.pathname === "/api/setGroupMembers"))
        .toHaveLength(3);
    } finally {
      f.gateway.stop();
    }
  });

  test("member validation rejects duplicates, nested groups, overflow, and empty removal before writes", async () => {
    const seven = Array.from({ length: 7 }, (_, index) => extraAgent(`agent-${index}`, `a${index}`));
    const f = await fixture([...sampleAgents(), ...seven]);
    try {
      const invalidCreateToggle = await f.run([
        "agents", "create", "--name", "bad-toggle", "--notify", "sometimes",
      ]);
      expect(invalidCreateToggle.code).toBe(2);

      const invalidUpdateToggle = await f.run([
        "groups", "update", "ops", "--name", "changed", "--hidden", "maybe",
      ]);
      expect(invalidUpdateToggle.code).toBe(2);

      const duplicate = await f.run(["groups", "create", "--name", "dup", "--member", "alpha", "agent-alpha"]);
      expect(duplicate.code).toBe(2);

      const nested = await f.run(["groups", "create", "--name", "nested", "--member", "ops"]);
      expect(nested.code).toBe(18);

      const overflow = await f.run([
        "groups", "create", "--name", "large", "--member",
        "a0", "a1", "a2", "a3", "a4", "a5", "a6",
      ]);
      expect(overflow.code).toBe(2);

      const empty = await f.run(["groups", "members", "remove", "ops", "alpha"]);
      expect(empty.code).toBe(2);
      expect(managementRequests(f.gateway)).toEqual([]);
    } finally {
      f.gateway.stop();
    }
  });

  test("TTY deletion prompts once and only writes after affirmative confirmation", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    try {
      const result = await f.run(["groups", "delete", "ops"], {
        stdinIsTTY: true,
        confirm: async (prompt) => {
          prompts.push(prompt);
          return true;
        },
      });
      expect(result.code).toBe(0);
      expect(prompts).toEqual(["Delete group 'ops' permanently? [y/N] "]);
      expect(managementRequests(f.gateway).map((request) => request.pathname)).toEqual(["/api/deleteAgent"]);
    } finally {
      f.gateway.stop();
    }
  });

  test("a lost management response is unknown and is never replayed", async () => {
    const f = await fixture();
    let writeAttempts = 0;
    const fetchWithLostWrite = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/updateAgent")) {
        writeAttempts += 1;
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
      const result = await f.run(
        ["--profile", "direct", "agents", "update", "alpha", "--title", "Lead"],
        { fetch: fetchWithLostWrite },
      );
      expect(result.code).toBe(28);
      const error = (parseJson(result.stderr) as { error: { code: string; context?: { operationId?: string } } }).error;
      expect(error.code).toBe("operation_outcome_unknown");
      expect(error.context?.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(writeAttempts).toBe(1);
    } finally {
      f.gateway.stop();
    }
  });

  test("a confirmed create reports partial object identity when post-create reconciliation is lost", async () => {
    const f = await fixture();
    const fetchWithLostFollowup = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/updateAgent")) throw new TypeError("simulated post-create loss");
      return await globalThis.fetch(input, init);
    }) as typeof fetch;
    try {
      await writeProfileFile(f.configDir, "direct", {
        version: 1,
        transport: "local",
        gateway_discovery: f.discoveryPath,
      });
      const result = await f.run([
        "--profile", "direct", "groups", "create", "--name", "New group", "--member", "alpha", "--title", "Team",
      ], { fetch: fetchWithLostFollowup });
      expect(result.code).toBe(28);
      const error = (parseJson(result.stderr) as {
        error: { code: string; context: { operationId: string; object: { id: string; kind: string }; phase: string } };
      }).error;
      expect(error.code).toBe("operation_outcome_unknown");
      expect(error.context).toMatchObject({
        operationId: nonce,
        object: { id: "group-created-1", kind: "group" },
        phase: "post-create",
      });
    } finally {
      f.gateway.stop();
    }
  });

  test("direct and local-daemon management return compatible projections", async () => {
    const f = await fixture();
    const deps = {
      ...createProductionDeps(),
      configDir: f.configDir,
      env: {},
      discoveryPath: f.discoveryPath,
      daemonSocket: f.socket,
      transport: "local" as const,
    };
    const host = await startDaemonHost(deps, f.socket);
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

      const direct = await f.run(["--profile", "direct", "agents", "update", "alpha", "--title", "Lead"]);
      const daemon = await f.run(["--profile", "daemon", "agents", "update", "alpha", "--title", "Lead"]);
      expect(direct.code).toBe(0);
      expect(daemon.code).toBe(0);
      const directBody = parseJson(direct.stdout) as { data: { agent: { updatedAt: number } } };
      const daemonBody = parseJson(daemon.stdout) as { data: { agent: { updatedAt: number } } };
      directBody.data.agent.updatedAt = 0;
      daemonBody.data.agent.updatedAt = 0;
      expect(daemonBody).toEqual(directBody);
    } finally {
      await host.close();
      f.gateway.stop();
    }
  });
});
