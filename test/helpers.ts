import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION, createProductionDeps, type CliDeps } from "../src/deps.ts";
import { runCli } from "../src/program.ts";

export const TEST_TOKEN = "test-gateway-token";
export const ENV_TOKEN = "env-secret-should-never-be-used";

export type RecordedRequest = {
  method: string;
  pathname: string;
  search: string;
  headerNames: string[];
  hasAuthorization: boolean;
  hasOrigin: boolean;
  slimAvatars: string | null;
  contentType: string | null;
  body: unknown;
};

export type MockOptions = {
  token?: string;
  pid?: number;
  startedAt?: number;
  host?: string;
  health?: Record<string, unknown>;
  agents?: unknown[];
  search?: unknown[];
  tail?: unknown;
  thread?: unknown;
  memories?: unknown[];
  sendPrompt?: (index: number, body: unknown) => { status: number; body?: unknown };
  eventsSse?: string;
};

export type MockGateway = {
  port: number;
  pid: number;
  startedAt: number;
  token: string;
  requests: RecordedRequest[];
  stop: () => void;
};

function recordRequest(req: Request, body: unknown): RecordedRequest {
  const url = new URL(req.url);
  return {
    method: req.method,
    pathname: url.pathname,
    search: url.search,
    headerNames: [...req.headers.keys()].sort(),
    hasAuthorization: req.headers.has("authorization"),
    hasOrigin: req.headers.has("origin"),
    slimAvatars: req.headers.get("x-sand-slim-avatars"),
    contentType: req.headers.get("content-type"),
    body,
  };
}

export function sampleAgents(): unknown[] {
  return [
    {
      id: "agent-alpha",
      name: "alpha",
      title: "",
      description: "research buddy",
      isGroup: false,
      isHiddenFromSidebar: false,
      isRunning: false,
      isRunningTurn: false,
      awaitingUserResponse: false,
      hasUnread: false,
      updatedAt: 100,
      path: "/secret/store.db",
      avatarDataUrl: "data:image/png;base64,AAAA",
      lastMessagePreview: "secret preview",
      memberIds: [],
    },
    {
      id: "group-ops",
      name: "ops",
      title: "Ops",
      description: "ops room",
      isGroup: true,
      isHiddenFromSidebar: false,
      isRunning: true,
      isRunningTurn: true,
      awaitingUserResponse: false,
      hasUnread: true,
      updatedAt: 200,
      path: "/secret/group.db",
      avatarDataUrl: "data:image/png;base64,BBBB",
      lastMessagePreview: "group preview",
      memberIds: ["agent-alpha"],
    },
    {
      id: "hidden-bot",
      name: "hidden",
      isGroup: false,
      isHiddenFromSidebar: true,
      isRunning: false,
      path: "/secret/hidden.db",
      avatarDataUrl: "data:image/png;base64,CCCC",
      lastMessagePreview: "hidden preview",
      updatedAt: 50,
    },
  ];
}

export async function startMockGateway(options: MockOptions = {}): Promise<MockGateway> {
  const token = options.token ?? TEST_TOKEN;
  const pid = options.pid ?? 4242;
  const startedAt = options.startedAt ?? 1_700_000_000_000;
  const requests: RecordedRequest[] = [];
  let sendCount = 0;
  const health = options.health ?? {
    ok: true,
    pid,
    isBusy: false,
    activeAgentId: null,
    startedAt,
    lastBusyAtMs: startedAt,
  };
  const initialAgents = options.agents ?? sampleAgents();
  const agents: Array<Record<string, unknown>> = structuredClone(initialAgents).filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row),
  );
  let createdAgentCount = 0;
  let createdGroupCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.has("origin")) {
        requests.push(recordRequest(req, null));
        return Response.json({ error: "origin-forbidden" }, { status: 403 });
      }
      const url = new URL(req.url);
      let body: unknown = null;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length === 0 ? {} : JSON.parse(text);
      }
      requests.push(recordRequest(req, body));
      const authorized =
        req.headers.get("authorization") === `Bearer ${token}`;

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(health);
      }
      if (!authorized) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/api/listAgents" && req.method === "POST") {
        return Response.json(agents);
      }
      if (url.pathname === "/api/createAgent" && req.method === "POST") {
        const input = body as Record<string, unknown>;
        createdAgentCount += 1;
        const agent: Record<string, unknown> = {
          id: `agent-created-${createdAgentCount}`,
          name: input.name,
          description: input.description,
          title: input.title ?? "",
          avatarShape: input.avatarShape,
          avatarColor: input.avatarColor,
          isGroup: false,
          isHiddenFromSidebar: false,
          isRunning: false,
          isRunningTurn: false,
          awaitingUserResponse: false,
          hasUnread: false,
          updatedAt: Date.now(),
          memberIds: [],
        };
        agents.push(agent);
        return Response.json({ agent, transcript: [] });
      }
      if (url.pathname === "/api/createGroup" && req.method === "POST") {
        const input = body as Record<string, unknown>;
        createdGroupCount += 1;
        const group: Record<string, unknown> = {
          id: `group-created-${createdGroupCount}`,
          name: input.name,
          description: input.description,
          title: "",
          isGroup: true,
          isHiddenFromSidebar: false,
          isRunning: false,
          isRunningTurn: false,
          awaitingUserResponse: false,
          hasUnread: false,
          updatedAt: Date.now(),
          memberIds: input.memberAgentIds,
        };
        agents.push(group);
        return Response.json({ agent: group, transcript: [] });
      }
      if (url.pathname === "/api/updateAgent" && req.method === "POST") {
        const input = body as { id?: unknown; profile?: unknown };
        const row = agents.find((candidate) => candidate.id === input.id);
        if (!row || input.profile === null || typeof input.profile !== "object" || Array.isArray(input.profile)) {
          return Response.json(null);
        }
        Object.assign(row, input.profile);
        row.updatedAt = Date.now();
        return Response.json(row);
      }
      if (url.pathname === "/api/setGroupMembers" && req.method === "POST") {
        const input = body as { id?: unknown; memberAgentIds?: unknown };
        const row = agents.find((candidate) => candidate.id === input.id && candidate.isGroup === true);
        if (!row) return Response.json(null);
        row.memberIds = input.memberAgentIds;
        row.updatedAt = Date.now();
        return Response.json(row);
      }
      if (url.pathname === "/api/setAgentNotifyOnUpdates" && req.method === "POST") {
        const input = body as { id?: unknown; isEnabled?: unknown };
        const row = agents.find((candidate) => candidate.id === input.id);
        if (row) row.notifyOnUpdatesEnabled = input.isEnabled;
        return Response.json(null);
      }
      if (url.pathname === "/api/setAgentHiddenFromSidebar" && req.method === "POST") {
        const input = body as { id?: unknown; isHidden?: unknown };
        const row = agents.find((candidate) => candidate.id === input.id);
        if (row) row.isHiddenFromSidebar = input.isHidden;
        return Response.json(null);
      }
      if (url.pathname === "/api/deleteAgent" && req.method === "POST") {
        const input = body as { id?: unknown };
        const index = agents.findIndex((candidate) => candidate.id === input.id);
        if (index >= 0) agents.splice(index, 1);
        return Response.json({ transcript: [] });
      }
      if (url.pathname === "/api/searchAgents" && req.method === "POST") {
        return Response.json(options.search ?? []);
      }
      if (url.pathname === "/api/getAgentTranscriptTail" && req.method === "POST") {
        return Response.json(
          options.tail ?? { entries: [{ kind: "user", text: "hello" }], nextBeforeSeq: 9 },
        );
      }
      if (url.pathname === "/api/getAgentThread" && req.method === "POST") {
        return Response.json(options.thread ?? { entries: [{ id: "root", kind: "user" }] });
      }
      if (url.pathname === "/api/getAgentMemories" && req.method === "POST") {
        return Response.json(
          options.memories ?? [
            { id: "mem-1", kind: "profile", createdAt: 1, content: "secret memory body" },
          ],
        );
      }
      if (url.pathname === "/api/sendPrompt" && req.method === "POST") {
        sendCount += 1;
        if (options.sendPrompt) {
          const scripted = options.sendPrompt(sendCount, body);
          return Response.json(scripted.body ?? { accepted: true }, { status: scripted.status });
        }
        return Response.json({ accepted: true });
      }
      if (url.pathname === "/events" && req.method === "GET") {
        const sse =
          options.eventsSse ??
          `retry: 1000\n\ndata: {"channel":"transcript","payload":{"type":"appended","entry":{"kind":"user"}}}\n\n`;
        return new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({ error: "not-found" }, { status: 404 });
    },
  });
  return {
    port: Number(server.port),
    pid,
    startedAt,
    token,
    requests,
    stop: () => server.stop(true),
  };
}

export async function writeDiscovery(file: {
  scheme?: string;
  host?: string;
  port: number;
  pid: number;
  startedAt: number;
  token: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-cli-"));
  const path = join(dir, "gateway.json");
  await writeFile(
    path,
    JSON.stringify({
      scheme: file.scheme ?? "http",
      host: file.host ?? "0.0.0.0",
      port: file.port,
      pid: file.pid,
      startedAt: file.startedAt,
      token: file.token,
    }),
  );
  return path;
}

export async function captureCli(
  argv: string[],
  overrides: Partial<CliDeps>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const base = createProductionDeps();
  const deps: CliDeps = {
    ...base,
    cliVersion: CLI_VERSION,
    configDir: await mkdtemp(join(tmpdir(), "grokbox-config-")),
    env: {},
    runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured in test" }),
    transport: "auto",
    daemonSocket: join(tmpdir(), `grokbox-test-${crypto.randomUUID()}.sock`),
    confirm: async () => false,
    stdinIsTTY: true,
    readStdin: async () => "",
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    ...overrides,
  };
  const code = await runCli(argv, deps);
  return { code, stdout, stderr };
}

export function assertNoSecrets(text: string, secrets: string[] = [TEST_TOKEN, ENV_TOKEN]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error("secret leaked into CLI output or fixture");
    }
  }
  if (/\bBearer\b/i.test(text)) {
    throw new Error("Bearer leaked into CLI output or fixture");
  }
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function rpcCalls(requests: RecordedRequest[], method: string): RecordedRequest[] {
  return requests.filter((req) => req.pathname === `/api/${method}`);
}
