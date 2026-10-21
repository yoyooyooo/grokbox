import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import type { CliDeps } from "../src/deps.ts";
import type { ServerCallDeps } from "../src/server-routines.ts";
import { assertNoSecrets, captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const TOKEN = "cloud-account-secret-never-output";
const BACKEND = "https://server.example.test";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCAL = "x-webhook";
// Deliberately unrelated to any derivation from the local ID.
const SERVER = "server-returned-automation-id";
const KEY = "crsr_fixture_webhook_key_do_not_leak";
const NIL = "00000000-0000-5000-8000-000000000000";

type Agent = { id: string; name: string; harness?: string; kind?: number };
type Automation = { serverId: string; record: string };
type Call = { path: string; authorization: string | null; body: Buffer; signal?: AbortSignal | null };

function varint(value: bigint | number): Buffer {
  let rest = BigInt(value);
  const bytes: number[] = [];
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 128);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

function field(number: number, value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LOCAL, name: "云上新任务", prompt: "PRIVATE prompt", trigger: { type: "webhook" },
    isEnabled: true, createdAt: 1792570713584, filePath: "/PRIVATE/path", credential: "PRIVATE credential",
    ...overrides,
  });
}

function automations(rows: Automation[] = [{ serverId: SERVER, record: record() }]): Buffer {
  return Buffer.concat(rows.map((row) => field(1, Buffer.concat([field(1, row.serverId), field(2, row.record)]))));
}

function proto(body: Buffer): Response {
  return new Response(new Uint8Array(body), { headers: { "content-type": "application/proto" } });
}

function fakeServer(options: {
  agents?: Agent[];
  automationBody?: Buffer;
  agentBody?: Buffer;
  mint?: (call: Call) => Response | Promise<Response>;
  probe?: (call: Call) => Response | Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: Parameters<CliDeps["fetch"]>[0], init?: Parameters<CliDeps["fetch"]>[1]) => {
    const path = new URL(String(input)).pathname;
    const call: Call = {
      path, authorization: new Headers(init?.headers).get("authorization"),
      body: Buffer.from((init?.body as Uint8Array | undefined) ?? []), signal: init?.signal,
    };
    calls.push(call);
    if (path.endsWith("/ListGrokBotAgents")) {
      if (options.agentBody) return proto(options.agentBody);
      return proto(Buffer.concat((options.agents ?? [{ id: AGENT, name: "新机器人", harness: "temporal" }]).map((agent) =>
        field(1, Buffer.concat([field(2, "legacy-not-a-public-uuid"), field(12, agent.id), field(3, agent.name), field(13, agent.harness ?? "temporal"), varint(19 * 8), varint(agent.kind ?? 1)])))));
    }
    if (path.endsWith("/ListGrokBotAgentAutomations")) return proto(options.automationBody ?? automations());
    if (path.endsWith("/CreateAutomationWebhookApiKey")) return options.mint ? await options.mint(call) : proto(field(1, KEY));
    if (path.startsWith("/automations/webhook/")) {
      // Any attempt to invoke the real Routine fails the test immediately.
      expect(path).toBe(`/automations/webhook/${NIL}`);
      return options.probe ? await options.probe(call) : Response.json({
        code: "error", message: `User API key missing required scope: automation:${NIL}`,
      }, { status: 401 });
    }
    throw new Error("Unexpected endpoint; Gateway/account fallback is forbidden");
  };
  return { fetch: fetchImpl as CliDeps["fetch"], calls };
}

async function fixture(options: Parameters<typeof fakeServer>[0] = {}, overrides: Partial<CliDeps> = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-cloud-routine-"));
  await writeProfileFile(configDir, "cloud", {
    version: 1, server: { access_token_ref: "env:CLOUD_TOKEN", backend_url: BACKEND },
  });
  const server = fakeServer(options);
  const run = (args: string[], extra: Partial<CliDeps> = {}) => captureCli(args, {
    configDir, env: { CLOUD_TOKEN: TOKEN, GROKBOX_PROFILE: "cloud" }, fetch: server.fetch,
    discoveryPath: "/dev/null", ...overrides, ...extra,
  });
  return { ...server, configDir, run };
}

const credentialArgs = ["agents", "routines", "webhook", "credential", "新机器人", LOCAL];

describe("unified agents routines cloud authority", () => {
  test("has no separate server command root", async () => {
    const f = await fixture();
    const result = await f.run(["server", "routines"]);
    expect(result.code).toBe(2);
    expect(f.calls.length).toBe(0);
  });

  test("Host verify is explicitly refused before any credential access", async () => {
    let requests = 0;
    const result = await captureCli([...credentialArgs, "--confirm", "--verify"], {
      discoveryPath: "/dev/null", fetch: (async () => { requests += 1; throw new Error("must not fetch"); }) as unknown as CliDeps["fetch"],
    });
    expect(result.code).toBe(22);
    expect(parseJson(result.stderr)).toMatchObject({ error: { code: "capability_unavailable" } });
    expect(requests).toBe(0);
  });

  test("reads a bridge-less new cloud bot with canonical envelopes and safe fields", async () => {
    const f = await fixture();
    const listed = await f.run(["agents", "routines", "list", "新机器人"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(parseJson(listed.stdout)).toMatchObject({ ok: true, data: {
      schemaVersion: 1, agentId: AGENT, authority: "server-temporal",
      coverage: { kind: "native_returned_window", complete: false },
      routines: [{ id: LOCAL, serverId: SERVER, name: "云上新任务", enabled: true,
        trigger: { type: "webhook" }, mutable: false, promptIncluded: false, credentialsIncluded: false,
        webhookUrl: `${BACKEND}/automations/webhook/${SERVER}` }],
    } });
    const shown = await f.run(["agents", "routines", "show", AGENT, SERVER]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(parseJson(shown.stdout)).toMatchObject({ data: { agentId: AGENT, routine: { id: LOCAL, serverId: SERVER } } });
    expect(listed.stdout + shown.stdout).not.toContain("PRIVATE");
    assertNoSecrets(listed.stdout + shown.stdout + listed.stderr, [TOKEN, KEY]);
    expect(f.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("preserves Gateway behavior when no explicit cloud credential exists", async () => {
    const gateway = await startMockGateway({ agents: [{ id: AGENT, name: "local", harness: "box" }],
      routines: { [AGENT]: [JSON.parse(record())] } });
    try {
      const discoveryPath = await writeDiscovery(gateway);
      const result = await captureCli(["agents", "routines", "list", "local"], { discoveryPath, transport: "gateway" });
      expect(result.code, result.stderr).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({ data: { authority: "box-local", routines: [{ id: LOCAL }] } });
      expect(gateway.requests.some((call) => call.pathname === "/api/getAgentAutomations")).toBe(true);
    } finally { gateway.stop(); }
  });

  test("cloud room kind is rejected and cannot shadow an agent with the same name", async () => {
    const f = await fixture({ agents: [{ id: AGENT, name: "same", kind: 1 }, { id: OTHER, name: "same", kind: 2 }] });
    expect((await f.run(["agents", "routines", "list", "same"])).code).toBe(0);
    const before = f.calls.length;
    expect((await f.run(["agents", "routines", "list", OTHER])).code).toBe(18);
    expect(f.calls.length).toBe(before + 1);
    const roomOnly = await fixture({ agents: [{ id: OTHER, name: "room", kind: 2 }] });
    expect((await roomOnly.run(["agents", "routines", "list", "room"])).code).toBe(18);
  });

  test("uses exact IDs first and rejects duplicate routine/agent names", async () => {
    const f = await fixture({ automationBody: automations([
      { serverId: SERVER, record: record() },
      { serverId: "second-server", record: record({ id: "second", name: "云上新任务" }) },
    ]) });
    const ambiguous = await f.run(["agents", "routines", "show", AGENT, "云上新任务"]);
    expect(ambiguous.code).toBe(19);
    expect((await f.run(["agents", "routines", "show", AGENT, SERVER])).code).toBe(0);
    expect((await f.run(["agents", "routines", "webhook", "credential", AGENT, "云上新任务", "--confirm"])).code).toBe(19);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(0);
    const duplicate = await fixture({ agents: [{ id: AGENT, name: "same" }, { id: OTHER, name: "same" }] });
    expect((await duplicate.run(["agents", "routines", "list", "same"])).code).toBe(19);
    expect((await duplicate.run(["agents", "routines", "list", AGENT])).code).toBe(0);
  });

  test("never searches a wrong account or cached roster on cloud target miss", async () => {
    const f = await fixture({ agents: [] });
    const result = await f.run(["agents", "routines", "list", "local-only-name"]);
    expect(result.code).toBe(17);
    expect(f.calls.map((call) => call.path)).toEqual(["/aiserver.v1.GrokBotService/ListGrokBotAgents"]);
    const missing = await f.run(["agents", "routines", "list", AGENT], { env: { GROKBOX_PROFILE: "cloud" } });
    expect(missing.code).toBe(29);
    assertNoSecrets(result.stderr + missing.stderr, [TOKEN, KEY]);
  });

  test("requires confirm before mint, reuses a protected key, reveals only on request", async () => {
    const f = await fixture();
    const denied = await f.run(credentialArgs);
    expect(denied.code).toBe(2);
    expect(f.calls.length).toBe(0);
    const hidden = await f.run([...credentialArgs, "--confirm"]);
    expect(hidden.code, hidden.stderr).toBe(0);
    expect(parseJson(hidden.stdout)).toMatchObject({ data: { routineId: LOCAL, serverId: SERVER, keyPresent: true, keyIncluded: false, promptIncluded: false } });
    const revealed = await f.run([...credentialArgs, "--confirm", "--reveal-key", "--verify"]);
    expect(revealed.code, revealed.stderr).toBe(0);
    expect(parseJson(revealed.stdout)).toMatchObject({ data: { keyIncluded: true, key: KEY, keyLive: true, promptIncluded: false } });
    expect(revealed.stdout).not.toContain("PRIVATE");
    assertNoSecrets(hidden.stdout + hidden.stderr + revealed.stderr, [TOKEN, KEY]);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
    const files = await readdir(join(f.configDir, "server-webhook-keys"));
    expect(files.filter((name) => name.endsWith(".json")).length).toBe(1);
    expect(f.calls.at(-1)?.path).toBe(`/automations/webhook/${NIL}`);
  });

  test("fails closed on corrupted or permissive key stores without minting again", async () => {
    for (const corrupt of [true, false]) {
      const f = await fixture();
      expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(0);
      const directory = join(f.configDir, "server-webhook-keys");
      const file = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
      if (corrupt) await writeFile(join(directory, file), "not JSON");
      else await chmod(join(directory, file), 0o644);
      expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(22);
      expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
    }
  });

  test("scopes cached credentials by backend, credential, agent, server ID and incarnation", async () => {
    const f = await fixture();
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(0);
    const directory = join(f.configDir, "server-webhook-keys");
    const before = await readdir(directory);
    const next = await f.run([...credentialArgs, "--confirm"], { env: { CLOUD_TOKEN: "different-principal", GROKBOX_PROFILE: "cloud" } });
    expect(next.code, next.stderr).toBe(0);
    expect((await readdir(directory)).length).toBe(before.length + 1);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(2);
    for (const name of await readdir(directory)) expect(await readFile(join(directory, name), "utf8")).not.toContain(TOKEN);
    for (const change of ["backend", "agent", "server-id", "created-at"] as const) {
      const fetcher = fakeServer({
        agents: [{ id: change === "agent" ? OTHER : AGENT, name: "新机器人" }],
        automationBody: automations([{ serverId: change === "server-id" ? "new-server-id" : SERVER,
          record: record(change === "created-at" ? { createdAt: 1792570713585 } : {}) }]),
      });
      if (change === "backend") await writeProfileFile(f.configDir, "cloud", {
        version: 1, server: { access_token_ref: "env:CLOUD_TOKEN", backend_url: "https://second.example.test" },
      });
      const result = await f.run([...credentialArgs, "--confirm"], { fetch: fetcher.fetch });
      expect(result.code, result.stderr).toBe(0);
      expect(fetcher.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
      if (change === "backend") await writeProfileFile(f.configDir, "cloud", {
        version: 1, server: { access_token_ref: "env:CLOUD_TOKEN", backend_url: BACKEND },
      });
    }
    expect((await readdir(directory)).filter((name) => name.endsWith(".json")).length).toBe(6);
  });

  test("rejects malformed required records/envelopes and duplicate IDs", async () => {
    const badBodies = [
      field(1, field(1, SERVER)), field(1, field(2, record())),
      Buffer.from([8, 1]), Buffer.from([0]), Buffer.from([10, 5, 1]),
      Buffer.concat([varint(80), Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 2])]),
      field(1, Buffer.concat([field(1, SERVER), field(2, Buffer.from([255]))])),
      field(1, Buffer.concat([field(1, SERVER), field(1, SERVER), field(2, record())])),
      Buffer.from([255, 255, 255, 255, 31, 0]),
      automations([{ serverId: SERVER, record: "{}" }]),
      automations([{ serverId: SERVER, record: record() }, { serverId: SERVER, record: record({ id: "second" }) }]),
      automations([{ serverId: SERVER, record: record() }, { serverId: "second", record: record() }]),
    ];
    for (const automationBody of badBodies) {
      const f = await fixture({ automationBody });
      const result = await f.run(["agents", "routines", "list", AGENT]);
      expect(result.code, result.stderr).toBe(22);
      assertNoSecrets(result.stderr, [TOKEN, KEY, "PRIVATE"]);
    }
  });

  test("skips legal unknown uint64 and fixed fields without loss of precision", async () => {
    const automationBody = Buffer.concat([automations(), varint(80), varint(18446744073709551615n),
      varint(89), Buffer.alloc(8), varint(101), Buffer.alloc(4)]);
    const f = await fixture({ automationBody });
    const result = await f.run(["agents", "routines", "list", AGENT]);
    expect(result.code, result.stderr).toBe(0);
    const grouped = await fixture({ automationBody: Buffer.concat([automationBody, varint(115), varint(8), varint(1), varint(116)]) });
    expect((await grouped.run(["agents", "routines", "list", AGENT])).code).toBe(0);
  });

  test("verification requires actual 401 and exact scope response, never remints", async () => {
    for (const [status, message] of [
      [200, `User API key missing required scope: automation:${NIL}`],
      [401, "User API key missing required scope: automation:wrong"],
      [403, `User API key missing required scope: automation:${NIL}`],
    ] as const) {
      const f = await fixture({ probe: () => Response.json({ code: "error", message }, { status }) });
      expect((await f.run([...credentialArgs, "--confirm", "--verify"])).code).toBe(22);
      expect((await f.run([...credentialArgs, "--confirm", "--verify"])).code).toBe(22);
      expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
    }
    const dead = await fixture({ probe: () => Response.json({ code: "error", message: "Invalid API key" }, { status: 401 }) });
    expect(parseJson((await dead.run([...credentialArgs, "--confirm", "--verify"])).stdout)).toMatchObject({ data: { keyLive: false } });
    const network = await fixture({ probe: () => { throw new Error("offline"); } });
    expect((await network.run([...credentialArgs, "--confirm", "--verify"])).code).toBe(22);
  });

  test("cancellation prevents mint or aborts verification and uncertain mint is not retried", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await fixture({}, { signal: controller.signal });
    expect((await cancelled.run([...credentialArgs, "--confirm"])).code).not.toBe(0);
    expect(cancelled.calls.length).toBe(0);
    const verifyController = new AbortController();
    const f = await fixture({ probe: async (call) => {
      verifyController.abort();
      expect(call.signal?.aborted).toBe(true);
      throw new Error("aborted");
    } }, { signal: verifyController.signal });
    expect((await f.run([...credentialArgs, "--confirm", "--verify"])).code).toBe(22);
    const uncertain = await fixture({ mint: () => { throw new Error("connection lost after mint"); } });
    const unknown = await uncertain.run([...credentialArgs, "--confirm"]);
    expect(unknown.code).toBe(28);
    expect(parseJson(unknown.stderr)).toMatchObject({ error: { code: "operation_outcome_unknown", retryable: false } });
    expect((await uncertain.run([...credentialArgs, "--confirm"])).code).toBe(22);
    expect(uncertain.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
  });

  test("cancelling during temporary store open leaves no lock and never dispatches mint", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const injected: Partial<CliDeps> & Pick<ServerCallDeps, "openWebhookKeyStore"> = {
      signal: controller.signal,
      openWebhookKeyStore: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        controller.abort();
        return handle;
      },
    };
    const cancelled = await f.run([...credentialArgs, "--confirm"], injected);
    expect(cancelled.code).toBe(22);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(0);
    expect(await readdir(join(f.configDir, "server-webhook-keys"))).toEqual([]);
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(0);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
  });

  test("mint 5xx is explicitly non-retryable and leaves an outcome lock", async () => {
    const f = await fixture({ mint: () => new Response("unavailable", { status: 503 }) });
    const result = await f.run([...credentialArgs, "--confirm"]);
    expect(result.code).toBe(28);
    expect(parseJson(result.stderr)).toMatchObject({ error: { code: "operation_outcome_unknown", retryable: false } });
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(22);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
  });

  test("missing incarnation refuses mint rather than deriving a default cache key", async () => {
    const f = await fixture({ automationBody: automations([{ serverId: SERVER, record: record({ createdAt: null }) }]) });
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(22);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(0);
  });

  test("rejects malformed cloud agent envelopes and duplicate IDs", async () => {
    for (const agentBody of [field(1, field(3, "missing-id")), Buffer.from([8, 1]),
      field(1, field(2, AGENT)),
      Buffer.concat([field(1, field(12, AGENT)), varint(3 * 8), varint(1)]),
      Buffer.concat([field(1, field(12, AGENT)), field(1, field(12, AGENT))])]) {
      const f = await fixture({ agentBody });
      expect((await f.run(["agents", "routines", "list", AGENT])).code).toBe(22);
      expect(f.calls.length).toBe(1);
    }
  });

  test("definitive mint refusal releases the lock without an automatic retry", async () => {
    let refused = true;
    const f = await fixture({ mint: () => refused
      ? Response.json({ message: "Only the automation owner can create webhook API keys" }, { status: 401 })
      : proto(field(1, KEY)) });
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(31);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(1);
    refused = false;
    expect((await f.run([...credentialArgs, "--confirm"])).code).toBe(0);
    expect(f.calls.filter((call) => call.path.endsWith("/CreateAutomationWebhookApiKey")).length).toBe(2);
  });
});
