import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import type { CliDeps } from "../src/deps.ts";
import { CliError } from "../src/errors.ts";
import {
  listServerAgents,
  listServerRoutines,
  mintWebhookKey,
  probeWebhookKey,
  stableAutomationId,
  webhookUrlFor,
} from "../src/server-routines.ts";
import { assertNoSecrets, captureCli, parseJson } from "./helpers.ts";

const SERVER_TOKEN = "server-account-token-should-never-be-printed";
const BACKEND = "https://server.example.test";
const AGENT = "98eedf67-6deb-4c35-a452-009cd9e22a77";
const ROUTINE_LOCAL_ID = "x-webhook";
const ROUTINE_SERVER_ID = "59557d02-396a-590a-8191-99ecbb5c0871";
const WEBHOOK_KEY = "crsr_fixture_webhook_key_do_not_leak";

// --- minimal protobuf writer, so the fake provider speaks the real wire format ---

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
}

function routineRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: ROUTINE_LOCAL_ID,
    name: "X 搜寻 webhook",
    prompt: "PRIVATE routine prompt",
    trigger: { type: "webhook" },
    isEnabled: true,
    createdAt: 1792570713584,
    filePath: "/PRIVATE/routine.json",
    credential: "PRIVATE_CREDENTIAL",
    ...overrides,
  });
}

function agentsResponse(): Buffer {
  const rows = [
    { id: AGENT, name: "小钻风", harness: "temporal" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "box-bot", harness: "box" },
  ];
  return Buffer.concat(rows.map((row) => field(1, Buffer.concat([
    field(1, Buffer.from(String(row.id.length), "utf8")),
    field(2, Buffer.from(row.id, "utf8")),
    field(3, Buffer.from(row.name, "utf8")),
    field(13, Buffer.from(row.harness, "utf8")),
  ]))));
}

function automationsResponse(record = routineRecord()): Buffer {
  return field(1, Buffer.concat([
    field(1, Buffer.from(ROUTINE_SERVER_ID, "utf8")),
    field(2, Buffer.from(record, "utf8")),
  ]));
}

type Call = { path: string; authorization: string | null; contentType: string | null; body: Buffer };

function fakeServer(handlers: {
  agents?: () => Response;
  automations?: (body: Buffer) => Response;
  mint?: (body: Buffer) => Response;
  probe?: (body: Buffer) => Response;
}): { fetch: CliDeps["fetch"]; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = Buffer.from((init?.body as Uint8Array | undefined) ?? new Uint8Array());
    calls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
      body,
    });
    if (url.pathname.endsWith("/ListGrokBotAgents")) {
      return handlers.agents ? handlers.agents() : proto(agentsResponse());
    }
    if (url.pathname.endsWith("/ListGrokBotAgentAutomations")) {
      return handlers.automations ? handlers.automations(body) : proto(automationsResponse());
    }
    if (url.pathname.endsWith("/CreateAutomationWebhookApiKey")) {
      return handlers.mint ? handlers.mint(body) : proto(field(1, Buffer.from(WEBHOOK_KEY, "utf8")));
    }
    if (url.pathname.startsWith("/automations/webhook/")) {
      return handlers.probe
        ? handlers.probe(body)
        : Response.json({ code: "error", message: "User API key missing required scope: automation:x" }, { status: 401 });
    }
    return new Response("unexpected path", { status: 500 });
  };
  return { fetch: fetchImpl as CliDeps["fetch"], calls };
}

function proto(body: Buffer): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { "content-type": "application/proto" },
  });
}

function deps(fetchImpl: CliDeps["fetch"], overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    fetch: fetchImpl,
    now: () => 1_700_000_000_000,
    signal: undefined,
    ...overrides,
  } as CliDeps;
}

async function serverProfile(configDir: string): Promise<void> {
  await writeProfileFile(configDir, "server", {
    version: 1,
    server: { access_token_ref: "env:SERVER_TOKEN", backend_url: BACKEND },
  });
}

describe("Server Routine surface", () => {
  test("derives the Server automation id from agent and local routine id", () => {
    expect(stableAutomationId(AGENT, ROUTINE_LOCAL_ID)).toBe(ROUTINE_SERVER_ID);
    expect(stableAutomationId("2a956666-854d-48a8-bc28-2430f178d374", "webhook"))
      .toBe("7913938a-0760-5079-a14a-b099fa1f3f5a");
    expect(webhookUrlFor(BACKEND, ROUTINE_SERVER_ID))
      .toBe(`${BACKEND}/automations/webhook/${ROUTINE_SERVER_ID}`);
  });

  test("lists agents and routines over bounded application/proto calls", async () => {
    const server = fakeServer({});
    const callDeps = deps(server.fetch);

    const agents = await listServerAgents(callDeps, {
      backendUrl: BACKEND,
      token: SERVER_TOKEN,
      timeoutMs: 5_000,
    });
    expect(agents).toEqual([
      { id: AGENT, name: "小钻风", harness: "temporal" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "box-bot", harness: "box" },
    ]);

    const routines = await listServerRoutines(callDeps, {
      backendUrl: BACKEND,
      token: SERVER_TOKEN,
      timeoutMs: 5_000,
      agentId: AGENT,
    });
    expect(routines).toEqual([{
      serverId: ROUTINE_SERVER_ID,
      localId: ROUTINE_LOCAL_ID,
      name: "X 搜寻 webhook",
      triggerType: "webhook",
      isEnabled: true,
      createdAtMs: 1792570713584,
      webhookUrl: `${BACKEND}/automations/webhook/${ROUTINE_SERVER_ID}`,
    }]);
    // The prompt, filesystem path, and credential in the native record never surface.
    expect(JSON.stringify(routines)).not.toContain("PRIVATE");

    for (const call of server.calls) {
      expect(call.contentType).toBe("application/proto");
      expect(call.authorization).toBe(`Bearer ${SERVER_TOKEN}`);
    }
    // The agent id travels as protobuf field 1, not as JSON.
    expect(server.calls[1]!.body.subarray(0, 2)).toEqual(Buffer.from([0x0a, AGENT.length]));
  });

  test("mints a webhook key and proves liveness without firing the routine", async () => {
    const server = fakeServer({});
    const callDeps = deps(server.fetch);
    const key = await mintWebhookKey(callDeps, {
      backendUrl: BACKEND,
      token: SERVER_TOKEN,
      timeoutMs: 5_000,
      serverId: ROUTINE_SERVER_ID,
    });
    expect(key).toBe(WEBHOOK_KEY);

    expect(await probeWebhookKey(callDeps, {
      backendUrl: BACKEND,
      token: SERVER_TOKEN,
      key,
      timeoutMs: 5_000,
    })).toBe(true);
    // The probe must never address the routine's own id: that would run it.
    const probeCall = server.calls.at(-1)!;
    expect(probeCall.path).toBe("/automations/webhook/00000000-0000-5000-8000-000000000000");

    const dead = fakeServer({
      probe: () => Response.json({ code: "error", message: "Invalid API key" }, { status: 401 }),
    });
    expect(await probeWebhookKey(deps(dead.fetch), {
      backendUrl: BACKEND,
      token: SERVER_TOKEN,
      key: "crsr_dead",
      timeoutMs: 5_000,
    })).toBe(false);
  });

  test("maps authorization refusals to typed credential failures", async () => {
    const server = fakeServer({
      mint: () => Response.json(
        { code: "unauthenticated", message: "Only the automation owner can create webhook API keys" },
        { status: 401 },
      ),
    });
    let failure: unknown;
    try {
      await mintWebhookKey(deps(server.fetch), {
        backendUrl: BACKEND,
        token: SERVER_TOKEN,
        timeoutMs: 5_000,
        serverId: ROUTINE_SERVER_ID,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("credential_invalid");
    expect((failure as CliError).failureCode).toBe("not_routine_owner");
  });

  test("rejects an oversized or malformed provider record instead of guessing", async () => {
    const malformed = fakeServer({
      automations: () => proto(automationsResponse(JSON.stringify({
        id: ROUTINE_LOCAL_ID,
        name: "malformed",
      }))),
    });
    let failure: unknown;
    try {
      await listServerRoutines(deps(malformed.fetch), {
        backendUrl: BACKEND,
        token: SERVER_TOKEN,
        timeoutMs: 5_000,
        agentId: AGENT,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("capability_unavailable");
    expect((failure as CliError).failureCode).toBe("routine_enabled_invalid");
  });
});

describe("grokbox server commands", () => {
  test("requires an explicit Server credential in the selected Profile", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-server-cmd-"));
    const result = await captureCli(["server", "agents"], {
      configDir,
      env: {},
      discoveryPath: "/dev/null",
    });
    expect(result.code).toBe(29);
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "credential_unavailable" },
    });
  });

  test("lists Server routines and keeps webhook keys hidden unless revealed", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-server-cmd-"));
    await serverProfile(configDir);
    const server = fakeServer({});
    const run = async (argv: string[]) => await captureCli(argv, {
      configDir,
      env: { SERVER_TOKEN, GROKBOX_PROFILE: "server" },
      fetch: server.fetch,
      discoveryPath: "/dev/null",
    });

    const listed = await run(["server", "routines", "--agent", "小钻风"]);
    expect(listed.code, listed.stderr).toBe(0);
    const listedBody = parseJson(listed.stdout) as {
      ok: boolean;
      data: { count: number; routines: Array<Record<string, unknown>> };
    };
    expect(listedBody.data.count).toBe(1);
    expect(listedBody.data.routines[0]).toMatchObject({
      serverId: ROUTINE_SERVER_ID,
      triggerType: "webhook",
    });
    assertNoSecrets(listed.stdout, [SERVER_TOKEN, WEBHOOK_KEY]);

    const hidden = await run([
      "server", "webhook", "credential",
      "--agent", "小钻风", "--routine", ROUTINE_LOCAL_ID,
    ]);
    expect(hidden.code, hidden.stderr).toBe(0);
    expect(parseJson(hidden.stdout)).toMatchObject({
      ok: true,
      data: {
        routineId: ROUTINE_LOCAL_ID,
        serverId: ROUTINE_SERVER_ID,
        url: `${BACKEND}/automations/webhook/${ROUTINE_SERVER_ID}`,
        keyPresent: true,
        keyIncluded: false,
      },
    });
    expect(hidden.stdout).not.toContain(WEBHOOK_KEY);
    assertNoSecrets(hidden.stdout, [SERVER_TOKEN]);

    const revealed = await run([
      "server", "webhook", "credential",
      "--agent", "小钻风", "--routine", ROUTINE_LOCAL_ID,
      "--reveal-key", "--verify",
    ]);
    expect(revealed.code, revealed.stderr).toBe(0);
    expect(parseJson(revealed.stdout)).toMatchObject({
      ok: true,
      data: { keyIncluded: true, key: WEBHOOK_KEY, keyLive: true },
    });
    assertNoSecrets(revealed.stdout, [SERVER_TOKEN]);
  });
});
