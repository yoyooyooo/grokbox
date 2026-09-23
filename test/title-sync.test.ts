import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import type { CliDeps } from "../packages/cli/src/deps.ts";
import type { GatewayClient } from "../packages/cli/src/gateway.ts";
import { applyAgentTitles, titleSyncModel } from "../packages/cli/src/title-sync.ts";
import { openRuntimeStore } from "@grokbox/box-runtime/runtime";
import { captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEMPORAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const at = "2026-09-13T10:00:00.000Z";

function ownershipRow(agentId: string, harness: "box" | "temporal") {
  return {
    agentId,
    serverEvidence: "found",
    server: { agentId, serverId: "owned-server", harness, viewerIsOwner: true },
    local: { before: { harness, serverId: "owned-server" }, after: { harness, serverId: "owned-server" }, stable: true },
  };
}

function ownershipSnapshot(rows: unknown[]) {
  return {
    schemaVersion: 1,
    observedAt: at,
    completedAt: at,
    state: "observed",
    source: "Host.official-client/ListGrokBotAgents",
    localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } },
    agents: rows,
  };
}

async function run(
  argv: string[],
  gateway: Awaited<ReturnType<typeof startMockGateway>>,
  extra: Partial<CliDeps> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-title-sync-"));
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
    confirm: async () => false,
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...extra,
  };
  await writeProfileFile(dir, "default", { version: 1, transport: "local", gateway_discovery: discoveryPath });
  return await captureCli(argv, deps);
}

function fakeTitleClient(): GatewayClient {
  return {
    getAgentOwnership: async () => {
      throw new Error("ownership offline");
    },
    updateAgent: async () => {
      throw new Error("unexpected title write");
    },
  } as unknown as GatewayClient;
}

test("titleSyncModel preserves missing tokens and clears only a confirmed empty assignment", () => {
  const tokens = new Map<string, string>([[A, "g46"]]);
  expect(titleSyncModel("box", A, tokens)).toBe("g46");
  expect(titleSyncModel("box", A, new Map())).toBeUndefined();
  expect(titleSyncModel("box", A, new Map(), new Set([A]))).toBeUndefined();
  expect(titleSyncModel("box", A, new Map(), new Set())).toBeNull();
  expect(titleSyncModel("box", A, tokens, new Set(["other"]))).toBeNull();
  expect(titleSyncModel("leave", A, tokens, new Set())).toBeUndefined();
  expect(titleSyncModel("temporal", A, tokens)).toBeNull();
});

test("applyAgentTitles sync omits m when the token is missing and clears only with no assignment", async () => {
  const showing = {
    id: A,
    name: "box-bot",
    title: "coding | owner=box,m=old",
    harness: "box",
  };
  const client = fakeTitleClient();
  const preserved = await applyAgentTitles(client, 1_000, {
    action: "sync",
    dryRun: true,
    rows: [showing],
    tokens: new Map(),
  });
  expect(preserved.rows[0]).toMatchObject({
    to: "coding | owner=box,m=old",
    m: "old",
    changed: false,
    written: false,
  });
  const unresolved = await applyAgentTitles(client, 1_000, {
    action: "sync",
    dryRun: true,
    rows: [showing],
    tokens: new Map(),
    assigned: new Set([A]),
  });
  expect(unresolved.rows[0]).toMatchObject({
    to: "coding | owner=box,m=old",
    m: "old",
    changed: false,
  });
  const cleared = await applyAgentTitles(client, 1_000, {
    action: "sync",
    dryRun: true,
    rows: [showing],
    tokens: new Map(),
    assigned: new Set(),
  });
  expect(cleared.rows[0]).toMatchObject({
    to: "coding | owner=box",
    m: null,
    changed: true,
    written: false,
  });
  const painted = await applyAgentTitles(client, 1_000, {
    action: "sync",
    dryRun: true,
    rows: [showing],
    tokens: new Map([[A, "g46"]]),
    assigned: new Set([A]),
  });
  expect(painted.rows[0]).toMatchObject({
    to: "coding | owner=box,m=g46",
    m: "g46",
    changed: true,
  });
});

const agents = [
  { id: A, name: "box-bot", title: "coding", description: "", isGroup: false, isHiddenFromSidebar: false, isRunning: false, hasUnread: false, updatedAt: 1, harness: "box" },
  { id: TEMPORAL, name: "temp-bot", title: "owner=box", description: "", isGroup: false, isHiddenFromSidebar: false, isRunning: false, hasUnread: false, updatedAt: 1, harness: "temporal" },
];

test("title show requires names or --all; paints user | owner= from live ownership", async () => {
  const gateway = await startMockGateway({
    agents: structuredClone(agents),
    hostStatus: { grokboxOwnership: ownershipSnapshot([ownershipRow(A, "box"), ownershipRow(TEMPORAL, "temporal")]) },
  });
  try {
    const missing = await run(["agents", "title", "show"], gateway);
    expect(missing.code).toBe(2);
    const shown = await run(["agents", "title", "show", "box-bot"], gateway);
    expect(shown.code).toBe(0);
    const body = parseJson(shown.stdout) as { data: { written: number; examined: number } };
    expect(body.data.examined).toBe(1);
    expect(body.data.written).toBe(1);
    const shownRow = await run(["agents", "show", "box-bot"], gateway);
    expect((parseJson(shownRow.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("coding | owner=box");
  } finally {
    gateway.stop();
  }
});

test("title show --all paints from roster harness when Server ownership is unconfirmed", async () => {
  const gateway = await startMockGateway({
    agents: structuredClone(agents),
    hostStatus: { version: "stock" },
  });
  try {
    const shown = await run(["agents", "title", "show", "--all", "--json"], gateway);
    expect(shown.code).toBe(0);
    const body = parseJson(shown.stdout) as {
      data: { examined: number; written: number; skipped: number; skips?: unknown[] };
    };
    expect(body.data.examined).toBe(2);
    expect(body.data.written).toBe(2);
    expect(body.data.skipped).toBe(0);
    expect(body.data.skips).toBeUndefined();
    const box = await run(["agents", "show", "box-bot"], gateway);
    expect((parseJson(box.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("coding | owner=box");
    const temp = await run(["agents", "show", "temp-bot"], gateway);
    expect((parseJson(temp.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("owner=temporal");
  } finally {
    gateway.stop();
  }
});

test("title show paints empty unknown titles as trailer-only owner=box", async () => {
  const blank = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    name: "Tech Leader",
    title: null,
    description: "",
    isGroup: false,
    isHiddenFromSidebar: false,
    isRunning: false,
    hasUnread: false,
    updatedAt: 1,
    harness: "unknown",
  };
  const gateway = await startMockGateway({
    agents: [blank, { ...agents[0]!, harness: "box" }],
    hostStatus: { version: "stock" },
  });
  try {
    const shown = await run(["agents", "title", "show", "--all", "--json"], gateway);
    expect(shown.code).toBe(0);
    const body = parseJson(shown.stdout) as {
      data: { examined: number; written: number; skipped: number; skips?: unknown[] };
    };
    expect(body.data).toMatchObject({ examined: 2, written: 2, skipped: 0 });
    expect(body.data.skips).toBeUndefined();
    const leader = await run(["agents", "show", "Tech Leader"], gateway);
    const leaderBody = parseJson(leader.stdout) as {
      data: { agent: { title: string | null; titleShowing: boolean } };
    };
    expect(leaderBody.data.agent.title).toBe("owner=box");
    expect(leaderBody.data.agent.titleShowing).toBe(true);
    const box = await run(["agents", "show", "box-bot"], gateway);
    expect((parseJson(box.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("coding | owner=box");
  } finally {
    gateway.stop();
  }
});

test("title show paints from user text and models.json when Server ownership is unconfirmed", async () => {
  const named = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    name: "named-bot",
    title: "Tech Leader",
    description: "",
    isGroup: false,
    isHiddenFromSidebar: false,
    isRunning: false,
    hasUnread: false,
    updatedAt: 1,
  };
  const assigned = {
    id: A,
    name: "assigned-bot",
    title: "",
    description: "",
    isGroup: false,
    isHiddenFromSidebar: false,
    isRunning: false,
    hasUnread: false,
    updatedAt: 1,
  };
  const gateway = await startMockGateway({
    agents: [named, assigned],
    hostStatus: { version: "stock" },
  });
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-title-models-"));
  await mkdir(join(boxRuntimeRoot, "state"), { recursive: true });
  await writeFile(join(boxRuntimeRoot, "models.json"), JSON.stringify({
    version: 3,
    models: {
      "openai-responses/grok-4.6": {
        provider: "openai-responses",
        model: "grok-4.6",
        endpoint: "https://example.invalid/v1",
        apiKeyRef: "env:GROKBOX_KEY",
        alias: "g46",
      },
    },
    assignments: { main: null, agents: { [A]: { modelId: "openai-responses/grok-4.6" } } },
  }), { mode: 0o600 });
  try {
    expect((await openRuntimeStore(boxRuntimeRoot, {}).loadModels()).assignments.agents[A]?.modelId).toBe("openai-responses/grok-4.6");
    const shown = await run(["agents", "title", "show", "--all", "--json"], gateway, { boxRuntimeRoot });
    expect(shown.code).toBe(0);
    const body = parseJson(shown.stdout) as { data: { examined: number; written: number; skipped: number } };
    expect(body.data).toMatchObject({ examined: 2, written: 2, skipped: 0 });
    const namedRow = await run(["agents", "show", "named-bot"], gateway);
    expect((parseJson(namedRow.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("Tech Leader | owner=box");
    const assignedRow = await run(["agents", "show", "assigned-bot"], gateway);
    expect((parseJson(assignedRow.stdout) as { data: { agent: { title: string | null } } }).data.agent.title)
      .toBe("owner=box,m=g46");
  } finally {
    gateway.stop();
  }
});

test("title hide strips trailers; sync skips hidden Bots and retains exact skip IDs", async () => {
  const gateway = await startMockGateway({
    agents: [
      { ...agents[0]!, title: "coding | owner=box,m=old" },
      { ...agents[1]!, title: "owner=box" },
    ],
    hostStatus: { grokboxOwnership: ownershipSnapshot([ownershipRow(A, "box"), ownershipRow(TEMPORAL, "temporal")]) },
  });
  try {
    const synced = await run(["agents", "title", "sync"], gateway);
    expect(synced.code).toBe(0);
    expect((parseJson(synced.stdout) as { data: { examined: number } }).data.examined).toBe(2);

    const hidden = await run(["agents", "title", "hide", "box-bot"], gateway);
    expect(hidden.code).toBe(0);
    expect((parseJson(hidden.stdout) as { data: { written: number; examined: number } }).data).toMatchObject({
      examined: 1,
      written: 1,
    });

    const afterHide = await run(["agents", "title", "sync", "box-bot", "--json"], gateway);
    expect((parseJson(afterHide.stdout) as { data: {
      examined: number;
      written: number;
      skipped: number;
      skips: Array<{ agent: string; id: string; reason: string }>;
    } }).data).toMatchObject({
      examined: 1,
      written: 0,
      skipped: 1,
      skips: [{ agent: "box-bot", id: A, reason: "hidden" }],
    });
  } finally {
    gateway.stop();
  }
});

test("title sync preserves m= when models.json is missing or the assigned record is unresolved", async () => {
  const showing = [{ ...agents[0]!, title: "coding | owner=box,m=old" }];
  const gateway = await startMockGateway({
    agents: structuredClone(showing),
    hostStatus: { grokboxOwnership: ownershipSnapshot([ownershipRow(A, "box")]) },
  });
  const unresolvedRoot = await mkdtemp(join(tmpdir(), "grokbox-title-unresolved-"));
  await writeFile(join(unresolvedRoot, "models.json"), JSON.stringify({
    version: 3,
    models: {},
    assignments: { main: null, agents: { [A]: { modelId: "openai-responses/grok-4.6" } } },
  }), { mode: 0o600 });
  try {
    const missing = await run(["agents", "title", "sync", "box-bot", "--json"], gateway);
    expect(missing.code).toBe(0);
    expect((parseJson(missing.stdout) as { data: { written: number } }).data.written).toBe(0);
    expect((parseJson((await run(["agents", "show", "box-bot"], gateway)).stdout) as {
      data: { agent: { title: string | null } };
    }).data.agent.title).toBe("coding | owner=box,m=old");

    const unresolved = await run(["agents", "title", "sync", "box-bot", "--json"], gateway, {
      boxRuntimeRoot: unresolvedRoot,
    });
    expect(unresolved.code).toBe(0);
    expect((parseJson(unresolved.stdout) as { data: { written: number } }).data.written).toBe(0);
    expect((parseJson((await run(["agents", "show", "box-bot"], gateway)).stdout) as {
      data: { agent: { title: string | null } };
    }).data.agent.title).toBe("coding | owner=box,m=old");
  } finally {
    gateway.stop();
  }
});

test("title sync clears m= only when models.json confirms no assignment", async () => {
  const showing = [{ ...agents[0]!, title: "coding | owner=box,m=old" }];
  const gateway = await startMockGateway({
    agents: structuredClone(showing),
    hostStatus: { grokboxOwnership: ownershipSnapshot([ownershipRow(A, "box")]) },
  });
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-title-empty-"));
  await writeFile(join(boxRuntimeRoot, "models.json"), JSON.stringify({
    version: 3,
    models: {},
    assignments: { main: null, agents: { [TEMPORAL]: { modelId: "openai-responses/grok-4.6" } } },
  }), { mode: 0o600 });
  try {
    const synced = await run(["agents", "title", "sync", "box-bot", "--json"], gateway, { boxRuntimeRoot });
    expect(synced.code).toBe(0);
    expect((parseJson(synced.stdout) as { data: { written: number } }).data.written).toBe(1);
    expect((parseJson((await run(["agents", "show", "box-bot"], gateway)).stdout) as {
      data: { agent: { title: string | null } };
    }).data.agent.title).toBe("coding | owner=box");
  } finally {
    gateway.stop();
  }
});

test("title sync paints a resolved token onto a showing trailer", async () => {
  const showing = [{ ...agents[0]!, title: "coding | owner=box,m=old" }];
  const gateway = await startMockGateway({
    agents: structuredClone(showing),
    hostStatus: { grokboxOwnership: ownershipSnapshot([ownershipRow(A, "box")]) },
  });
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-title-resolved-"));
  await writeFile(join(boxRuntimeRoot, "models.json"), JSON.stringify({
    version: 3,
    models: {
      "openai-responses/grok-4.6": {
        provider: "openai-responses",
        model: "grok-4.6",
        endpoint: "https://example.invalid/v1",
        apiKeyRef: "env:GROKBOX_KEY",
        alias: "g46",
      },
    },
    assignments: { main: null, agents: { [A]: { modelId: "openai-responses/grok-4.6" } } },
  }), { mode: 0o600 });
  try {
    const synced = await run(["agents", "title", "sync", "box-bot", "--json"], gateway, { boxRuntimeRoot });
    expect(synced.code).toBe(0);
    expect((parseJson(synced.stdout) as { data: { written: number } }).data.written).toBe(1);
    expect((parseJson((await run(["agents", "show", "box-bot"], gateway)).stdout) as {
      data: { agent: { title: string | null } };
    }).data.agent.title).toBe("coding | owner=box,m=g46");
  } finally {
    gateway.stop();
  }
});

// General Bot create/update tests moved to packages/server/test/products.node.ts.
// Explicit title synchronization above still owns model-token refresh; the
// reviewed product update preserves existing metadata without a hidden refresh.
