import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import cliPackage from "../package.json";
import type { CliDeps } from "../src/deps.ts";
import { GLOBAL_OPTIONS, LEAF_COMMANDS, TOP_LEVEL_COMMANDS } from "../src/registry.ts";
import {
  assertNoSecrets,
  captureCli,
  ENV_TOKEN,
  parseJson,
  rpcCalls,
  sampleAgents,
  startMockGateway,
  TEST_TOKEN,
  writeDiscovery,
  type MockGateway,
} from "./helpers.ts";

const repoDir = join(import.meta.dir, "..");
const skillsDir = join(repoDir, "skills");
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let mock: MockGateway | undefined;

afterEach(() => {
  mock?.stop();
  mock = undefined;
  delete process.env.SAND_GATEWAY_TOKEN;
});

async function withGateway(
  argv: string[],
  extras?: Parameters<typeof startMockGateway>[0] & {
    stdinIsTTY?: boolean;
    stdin?: string;
    host?: string;
    envToken?: boolean;
    configDir?: string;
    profileEnv?: Readonly<Record<string, string | undefined>>;
    runCommand?: CliDeps["runCommand"];
  },
) {
  if (extras?.envToken === false) delete process.env.SAND_GATEWAY_TOKEN;
  else process.env.SAND_GATEWAY_TOKEN = ENV_TOKEN;
  mock = await startMockGateway(extras);
  const discoveryPath = await writeDiscovery({
    host: extras?.host ?? "0.0.0.0",
    port: mock.port,
    pid: mock.pid,
    startedAt: mock.startedAt,
    token: mock.token,
  });
  let stdinReads = 0;
  const result = await captureCli(argv, {
    discoveryPath,
    skillsDir,
    ...(extras?.configDir === undefined ? {} : { configDir: extras.configDir }),
    env: extras?.profileEnv ?? {},
    runCommand:
      extras?.runCommand ??
      (async () => ({ code: 127, stdout: "", stderr: "not configured in test" })),
    stdinIsTTY: extras?.stdinIsTTY ?? true,
    readStdin: async () => {
      stdinReads += 1;
      return extras?.stdin ?? "";
    },
    now: () => 1_234,
    randomUUID: () => nonce,
  });
  const snapshot = JSON.stringify({
    argv,
    stdout: result.stdout,
    stderr: result.stderr,
    requests: mock.requests,
  });
  assertNoSecrets(snapshot);
  return { ...result, mock, snapshot, stdinReads };
}

function errorCode(stderr: string): string {
  return (parseJson(stderr) as { error: { code: string } }).error.code;
}

describe("registry, help, and runtime", () => {
  test("root help is agent-first and has no raw or secret options", async () => {
    const result = await captureCli(["--help"], { skillsDir, discoveryPath: "/dev/null" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Start here (for Agents):");
    expect(TOP_LEVEL_COMMANDS).toEqual([
      "init",
      "skills",
      "profile",
      "daemon",
      "doctor",
      "quota",
      "recover",
      "box",
      "agents",
      "groups",
      "send",
      "history",
      "memory",
      "fs",
      "exec",
      "jobs",
      "desktop",
      "events",
      "is",
    ]);
    for (const name of TOP_LEVEL_COMMANDS) expect(result.stdout).toContain(name);
    expect(TOP_LEVEL_COMMANDS).not.toContain("credential");
    expect(LEAF_COMMANDS.map((leaf) => leaf.path.join(" "))).not.toContain("credential sync");
    expect(result.stdout).not.toMatch(/^\s+raw\b/m);
    expect(result.stdout).not.toContain("--token");
    expect(result.stdout).not.toContain("--gateway-url");
    expect(result.stdout).not.toContain("help [command]");
    assertNoSecrets(result.stdout + result.stderr);
  });

  test("registry metadata is internally consistent", () => {
    expect(GLOBAL_OPTIONS.map((option) => option.flags)).toEqual([
      "--profile <name>",
      "--json",
      "--table",
      "--timeout-ms <n>",
    ]);
    const fsRead = LEAF_COMMANDS.find((leaf) => leaf.path.join(" ") === "fs read")!;
    const fsList = LEAF_COMMANDS.find((leaf) => leaf.path.join(" ") === "fs list")!;
    const fsDownload = LEAF_COMMANDS.find((leaf) => leaf.path.join(" ") === "fs download")!;
    expect(fsRead.table).toBe(false);
    expect(fsRead.timeout).toBe(true);
    expect(fsList.table).toBe(true);
    expect(fsDownload.table).toBe(false);
    expect(fsDownload.timeout).toBe(true);
    expect(fsDownload.streaming).toBe(true);
    for (const leaf of LEAF_COMMANDS) {
      const flags = leaf.options.map((option) => option.flags);
      expect(flags.some((flag) => flag.includes("--table"))).toBe(leaf.table);
      expect(flags.some((flag) => flag.includes("--timeout-ms"))).toBe(leaf.timeout);
      expect(flags.some((flag) => flag.includes("--text"))).toBe(leaf.stdin === "text");
      const roleArguments = leaf.arguments.filter((argument) => argument.role);
      expect(new Set(roleArguments.map((argument) => argument.role)).size).toBe(roleArguments.length);
      for (const argument of roleArguments) expect(argument.kinds?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("every leaf help projects exactly its registry option set", async () => {
    for (const leaf of LEAF_COMMANDS) {
      const result = await captureCli([...leaf.path, "--help"], {
        skillsDir,
        discoveryPath: "/dev/null",
      });
      expect(result.code).toBe(0);
      const expected = new Set(
        leaf.options.flatMap((option) => option.flags.match(/--[a-z][a-z0-9-]*/g) ?? []),
      );
      expected.add("--help");
      const helpLongOptions = new Set(
        [...result.stdout.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)(?=[\s,]|$)/gm)].map((match) => match[1]),
      );
      expect(helpLongOptions).toEqual(expected);
    }
  });

  test("removed routes and unsupported options fail locally", async () => {
    const removed = [
      ["raw", "sendPrompt"],
      ["agents", "search", "x"],
      ["agents", "list", "--kind", "all"],
      ["agents", "show", "agent-alpha", "--history", "10"],
      ["send", "--agent", "agent-alpha", "--text", "x"],
      ["memory", "list", "--agent", "agent-alpha"],
      ["--table", "send", "agent-alpha", "--text", "x"],
      ["profile", "doctor"],
      ["daemon", "doctor"],
      ["doctor", "--repair"],
      ["recover", "--bootstrap"],
    ];
    for (const argv of removed) {
      const result = await withGateway(argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(errorCode(result.stderr)).toBe("invalid_usage");
      expect(result.mock.requests).toEqual([]);
      result.mock.stop();
      mock = undefined;
    }
  });

  test("declared global options work before the command path", async () => {
    const result = await withGateway(["--table", "agents", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("agent-alpha");
    expect(result.mock.requests.map((request) => request.pathname)).toEqual(["/api/listAgents"]);
  });

  test("bundled full skill is generated from the same registry", async () => {
    const result = await captureCli(["skills", "get", "core", "--full"], {
      skillsDir,
      discoveryPath: "/dev/null",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# grokbox core");
    expect(result.stdout).toContain("Leaf commands");
    for (const leaf of LEAF_COMMANDS) {
      expect(result.stdout).toContain(`### \`${leaf.path.join(" ")}\``);
      expect(result.stdout).toContain(leaf.usage);
    }
    expect(result.stdout).not.toContain("send --agent");
    expect(result.stdout).not.toContain("agents search");
  });

  test("published shim and both bin names target Node", async () => {
    const build = Bun.spawn(["bun", "run", "build"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    expect(await build.exited).toBe(0);
    const proc = Bun.spawn(["node", join(repoDir, "bin/grokbox"), "--help"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("groups");
    expect(stderr).toBe("");
    expect(cliPackage.engines).toEqual({ node: ">=20.0.0" });
    expect(cliPackage.bin).toEqual({ grokbox: "bin/grokbox", gbox: "bin/grokbox" });
    assertNoSecrets(stdout + stderr);
  });
});

describe("discovery and HTTP boundaries", () => {
  test("wildcard host dials loopback and doctor does not send Bearer", async () => {
    const result = await withGateway(["doctor"]);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: {
        discovery: { bindHost: string; dialHost: string; tokenPresent: boolean };
        checks: { authenticatedCommand: string; loopbackTarget: boolean };
      };
    };
    expect(body.data.discovery.bindHost).toBe("0.0.0.0");
    expect(body.data.discovery.dialHost).toBe("127.0.0.1");
    expect(body.data.discovery.tokenPresent).toBe(true);
    expect(body.data.checks.loopbackTarget).toBe(true);
    expect(body.data.checks.authenticatedCommand).toBe("not-probed");
    expect(result.mock.requests).toHaveLength(1);
    expect(result.mock.requests[0]?.pathname).toBe("/health");
    expect(result.mock.requests[0]?.hasAuthorization).toBe(false);
    expect(result.mock.requests[0]?.hasOrigin).toBe(false);
  });

  test("non-loopback discovery is reported unhealthy without HTTP", async () => {
    const result = await withGateway(["doctor"], { host: "8.8.8.8" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const report = (parseJson(result.stdout) as { data: { ok: boolean; checks: { gateway: { code: string } } } }).data;
    expect(report.ok).toBe(false);
    expect(report.checks.gateway.code).toBe("discovery_unavailable");
    expect(result.mock.requests).toEqual([]);
  });

  test("authenticated calls omit Origin, set slim, and ignore SAND_GATEWAY_TOKEN", async () => {
    const result = await withGateway(["agents", "list"]);
    expect(result.code).toBe(0);
    const request = result.mock.requests[0];
    expect(request?.pathname).toBe("/api/listAgents");
    expect(request?.hasOrigin).toBe(false);
    expect(request?.hasAuthorization).toBe(true);
    expect(request?.slimAvatars).toBe("1");
    expect(request?.headerNames).not.toContain("origin");
    expect(JSON.stringify(request)).not.toMatch(/Bearer/i);
    expect(JSON.stringify(request)).not.toContain(TEST_TOKEN);
    expect(result.snapshot).not.toContain(ENV_TOKEN);
  });
});

describe("strict agents, groups, and target resolution", () => {
  test("agents and groups list are disjoint and redacted", async () => {
    const agents = await withGateway(["agents", "list"]);
    const agentBody = parseJson(agents.stdout) as {
      data: { count: number; agents: Array<Record<string, unknown>> };
    };
    expect(agentBody.data.count).toBe(1);
    expect(agentBody.data.agents.map((row) => row.id)).toEqual(["agent-alpha"]);
    expect(JSON.stringify(agentBody)).not.toContain("/secret/");
    agents.mock.stop();
    mock = undefined;

    const groups = await withGateway(["groups", "list"]);
    const groupBody = parseJson(groups.stdout) as {
      data: { count: number; groups: Array<Record<string, unknown>> };
    };
    expect(groupBody.data.count).toBe(1);
    expect(groupBody.data.groups.map((row) => row.id)).toEqual(["group-ops"]);
    expect(JSON.stringify(groupBody)).not.toContain("avatarDataUrl");
  });

  test("show commands are atomic and enforce their domain", async () => {
    const agent = await withGateway(["agents", "show", "alpha"]);
    expect(agent.code).toBe(0);
    expect(agent.mock.requests.map((request) => request.pathname)).toEqual(["/api/listAgents"]);
    const agentBody = parseJson(agent.stdout) as { data: Record<string, unknown> };
    expect(agentBody.data.agent).toBeDefined();
    expect(agentBody.data.history).toBeUndefined();
    agent.mock.stop();
    mock = undefined;

    const group = await withGateway(["groups", "show", "Ops"]);
    expect(group.code).toBe(0);
    expect(group.mock.requests.map((request) => request.pathname)).toEqual(["/api/listAgents"]);
    group.mock.stop();
    mock = undefined;

    const mismatch = await withGateway(["agents", "show", "group-ops"]);
    expect(mismatch.code).toBe(18);
    expect(errorCode(mismatch.stderr)).toBe("target_kind_mismatch");
  });

  test("group membership list uses the canonical nested route", async () => {
    const result = await withGateway(["groups", "members", "list", "ops"]);
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: { group: { id: string }; members: Array<{ id: string }>; missingMemberIds: string[] };
    };
    expect(body.data.group.id).toBe("group-ops");
    expect(body.data.members.map((member) => member.id)).toEqual(["agent-alpha"]);
    expect(body.data.missingMemberIds).toEqual([]);
  });

  test("exact ID wins before ambiguous name/title matching", async () => {
    const duplicate = {
      ...(sampleAgents()[0] as Record<string, unknown>),
      id: "agent-alpha-2",
      title: "Alpha",
    };
    const result = await withGateway(["send", "agent-alpha", "--text", "x"], {
      agents: [...sampleAgents(), duplicate],
    });
    expect(result.code).toBe(0);
    expect(rpcCalls(result.mock.requests, "sendPrompt")[0]?.body).toEqual({
      agentId: "agent-alpha",
      prompt: "x",
      clientNonce: nonce,
    });
  });

  test("ambiguous names fail before side effects", async () => {
    const duplicate = {
      ...sampleAgents()[0] as Record<string, unknown>,
      id: "agent-alpha-2",
      title: "Alpha",
    };
    const result = await withGateway(["send", "alpha", "--text", "x"], {
      agents: [...sampleAgents(), duplicate],
    });
    expect(result.code).toBe(19);
    expect(errorCode(result.stderr)).toBe("target_ambiguous");
    expect(rpcCalls(result.mock.requests, "sendPrompt")).toEqual([]);
  });
});

describe("send", () => {
  test("positional target and expected-kind issue one three-field send", async () => {
    const result = await withGateway([
      "send",
      "Ops",
      "--expect-kind",
      "group",
      "--text",
      "hi team",
      "--nonce",
      nonce,
    ]);
    expect(result.code).toBe(0);
    const sends = rpcCalls(result.mock.requests, "sendPrompt");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({ agentId: "group-ops", prompt: "hi team", clientNonce: nonce });
    expect(Object.keys(sends[0]?.body as object).sort()).toEqual(["agentId", "clientNonce", "prompt"]);
    expect(result.stdout).not.toContain("hi team");
  });

  test("explicit --text suppresses stdin reads in a non-TTY runner", async () => {
    const result = await withGateway(["send", "alpha", "--text", "explicit"], {
      stdinIsTTY: false,
      stdin: "must not be read",
    });
    expect(result.code).toBe(0);
    expect(result.stdinReads).toBe(0);
    expect(rpcCalls(result.mock.requests, "sendPrompt")[0]?.body).toEqual({
      agentId: "agent-alpha",
      prompt: "explicit",
      clientNonce: nonce,
    });
  });

  test("stdin is consumed only when --text is absent", async () => {
    const result = await withGateway(["send", "agent-alpha"], {
      stdinIsTTY: false,
      stdin: "from stdin\n",
    });
    expect(result.code).toBe(0);
    expect(result.stdinReads).toBe(1);
    expect(rpcCalls(result.mock.requests, "sendPrompt")[0]?.body).toEqual({
      agentId: "agent-alpha",
      prompt: "from stdin",
      clientNonce: nonce,
    });
  });

  test("expected-kind mismatch rejects before sendPrompt", async () => {
    const result = await withGateway(["send", "ops", "--expect-kind", "agent", "--text", "nope"]);
    expect(result.code).toBe(18);
    expect(errorCode(result.stderr)).toBe("target_kind_mismatch");
    expect(rpcCalls(result.mock.requests, "sendPrompt")).toEqual([]);
  });

  test("401 does not resend a write with unchanged stale discovery", async () => {
    const result = await withGateway(["send", "alpha", "--text", "hello", "--nonce", nonce], {
      sendPrompt: () => ({ status: 401, body: { error: "unauthorized" } }),
    });
    expect(result.code).toBe(11);
    const sends = rpcCalls(result.mock.requests, "sendPrompt");
    expect(sends).toHaveLength(1);
    expect((sends[0]?.body as { clientNonce: string }).clientNonce).toBe(nonce);
  });
});

describe("history, memory, events, and running", () => {
  test("history search owns transcript search", async () => {
    const result = await withGateway(["history", "search", "deployment", "--limit", "5"], {
      search: [{ agentId: "agent-alpha", entryId: "e1", role: "user", timestampMs: 1, snippet: "ok" }],
    });
    expect(result.code).toBe(0);
    expect(rpcCalls(result.mock.requests, "searchAgents")[0]?.body).toEqual({
      query: "deployment",
      limit: 5,
    });
  });

  test("history tail resolves a name without openAgent", async () => {
    const result = await withGateway(["history", "tail", "alpha", "--limit", "20"]);
    expect(result.code).toBe(0);
    const paths = result.mock.requests.map((request) => request.pathname);
    expect(paths).toEqual(["/api/listAgents", "/api/getAgentTranscriptTail"]);
    expect(paths.some((path) => path.startsWith("/api/openAgent"))).toBe(false);
    const body = parseJson(result.stdout) as { data: { id: string; nextBeforeSeq: number } };
    expect(body.data.id).toBe("agent-alpha");
    expect(body.data.nextBeforeSeq).toBe(9);
  });

  test("memory list uses a positional agent and strips content by default", async () => {
    const hidden = await withGateway(["memory", "list", "alpha"]);
    expect(hidden.code).toBe(0);
    const hiddenBody = parseJson(hidden.stdout) as {
      data: { agentId: string; memories: Array<Record<string, unknown>> };
    };
    expect(hiddenBody.data.agentId).toBe("agent-alpha");
    expect(hiddenBody.data.memories[0]?.content).toBeUndefined();
    expect(hiddenBody.data.memories[0]?.contentBytes).toBeGreaterThan(0);
    hidden.mock.stop();
    mock = undefined;

    const shown = await withGateway(["memory", "list", "agent-alpha", "--content"]);
    const shownBody = parseJson(shown.stdout) as {
      data: { memories: Array<Record<string, unknown>> };
    };
    expect(shownBody.data.memories[0]?.content).toBe("secret memory body");
  });

  test("events default subset is NDJSON and redacts roster secrets", async () => {
    const sse = [
      "retry: 1000",
      "",
      `data: ${JSON.stringify({
        channel: "agents",
        payload: { agents: sampleAgents(), coverage: { kind: "complete-roster" } },
      })}`,
      "",
    ].join("\n");
    const result = await withGateway(["events", "--once"], { eventsSse: sse });
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    const line = parseJson(result.stdout) as {
      event: { channel: string; payload: { agents: Array<Record<string, unknown>> } };
    };
    expect(line.event.channel).toBe("agents");
    expect(JSON.stringify(line)).not.toContain("avatarDataUrl");
    expect(JSON.stringify(line)).not.toContain("/secret/");
    const event = result.mock.requests.find((request) => request.pathname === "/events");
    expect(event?.hasOrigin).toBe(false);
    expect(event?.slimAvatars).toBe("1");
  });

  test("direct Gateway once reports an empty disconnected interval as a gap", async () => {
    const result = await withGateway(["events", "--once"], { eventsSse: "" });
    expect(result.code, result.stderr).toBe(0);
    const line = parseJson(result.stdout) as {
      event: { source: string; kind: string; payload: { reason: string; resumable: boolean } };
      cursor: string;
    };
    expect(line.event).toMatchObject({
      source: "gateway",
      kind: "gap",
      payload: { reason: "stream_disconnected", resumable: false },
    });
    expect(line.cursor).toBe("direct:1");
  });

  test("direct Gateway once reports partial EOF exactly once as a gap", async () => {
    const result = await withGateway(["events", "--once"], { eventsSse: 'data: {"channel":"agents"' });
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = parseJson(lines[0]!) as { event: { kind: string; payload: { reason: string; resumable: boolean } } };
    expect(line.event).toMatchObject({ kind: "gap", payload: { reason: "malformed_frame", resumable: false } });
  });

  test("is running resolves a cross-kind title through listAgents", async () => {
    const result = await withGateway(["is", "running", "Ops"]);
    expect(result.code).toBe(0);
    expect(result.mock.requests.map((request) => request.pathname)).toEqual(["/api/listAgents"]);
    const body = parseJson(result.stdout) as { data: { id: string; isRunning: boolean } };
    expect(body.data.id).toBe("group-ops");
    expect(body.data.isRunning).toBe(true);
  });

  test("usage failure leaves stdout empty", async () => {
    const result = await withGateway(["history", "thread", "agent-alpha"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.mock.requests).toEqual([]);
  });
});
