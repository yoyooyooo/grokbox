import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBoxRoutineAuth, type BoxRoutineAuthIO } from "../src/box-routine-auth.ts";
import { createProductionDeps, type CliDeps } from "../src/deps.ts";
import { assertNoSecrets, captureCli, parseJson } from "./helpers.ts";

const RENEWAL = "fixture-renewal-private";
const TOKEN = "fixture-short-lived-private";
const KEY = "crsr_native_test_private_key";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISCOVERY = { scheme: "http", host: "127.0.0.1", port: 9000, pid: 123, startedAt: 1000, token: "gateway-private" };
const HOST = { uid: 1000, start: "100", cmdline: "/exec-daemon/node\0--disable-warning=ExperimentalWarning\0/opt/sand/sand-host/host-main.cjs\0" };
function field(n: number, value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length: number[] = [];
  let rest = bytes.length;
  while (rest > 127) { length.push((rest & 127) | 128); rest >>>= 7; }
  return Buffer.concat([Buffer.from([n * 8 + 2, ...length, rest]), bytes]);
}
function proto(value: Buffer): Response {
  return new Response(new Uint8Array(value), { headers: { "content-type": "application/proto" } });
}
async function fixture() {
  let environmentReads = 0;
  let renewals = 0;
  let mints = 0;
  const calls: string[] = [];
  const io: BoxRoutineAuthIO = {
    platform: "linux", uid: 1000, process: async () => HOST,
    environment: async () => { environmentReads++; return Buffer.from(`SAND_PACKAGED=1\0OTHER=private\0SAND_INFERENCE_RENEWAL_CREDENTIAL=${RENEWAL}\0`); },
  };
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-native-auth-"));
  const deps: CliDeps = { ...createProductionDeps(), env: {}, configDir, boxRoutineAuthIO: io,
    now: () => 1000, readFile: async () => JSON.stringify(DISCOVERY),
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/health") return Response.json({ pid: 123, startedAt: 1000 });
      if (path === "/sand-box/inference-credential") {
        renewals++;
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual({ credential: RENEWAL });
        return Response.json({ accessToken: `${TOKEN}-${renewals}`, expiresAtMs: 100_000 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}-${renewals}`);
      if (path.endsWith("/ListGrokBotAgents")) return proto(field(1, Buffer.concat([
        field(2, "wrong-legacy-id"), field(12, AGENT), field(3, "新机器人"), field(13, "temporal"), Buffer.from([152, 1, 1]),
      ])));
      if (path.endsWith("/ListGrokBotAgentAutomations")) return proto(field(1, Buffer.concat([
        field(1, "server-routine"), field(2, JSON.stringify({ id: "routine", name: "任务", prompt: "private prompt", trigger: { type: "webhook" }, isEnabled: true, createdAt: 100 })),
      ])));
      if (path.endsWith("/CreateAutomationWebhookApiKey")) { mints++; return proto(field(1, KEY)); }
      throw new Error("unexpected private provider endpoint");
    }) as CliDeps["fetch"],
  };
  const run = (args: string[]) => {
    const { stdout: _stdout, stderr: _stderr, ...overrides } = deps;
    return captureCli(args, overrides);
  };
  return { deps, io, calls, run, counts: () => ({ environmentReads, renewals, mints }) };
}
const credentialArgs = ["agents", "routines", "webhook", "credential", "新机器人", "routine"];

describe("verified current-box Routine authentication", () => {
  test("default local list/show uses canonical cloud field12 without server config", async () => {
    const f = await fixture();
    for (const args of [["agents", "routines", "list", "新机器人"], ["agents", "routines", "show", AGENT, "routine"]]) {
      const result = await f.run(args);
      expect(result.code, result.stderr).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({ data: { agentId: AGENT, authority: "server-temporal" } });
      assertNoSecrets(result.stdout + result.stderr, [RENEWAL, TOKEN, KEY, "private prompt"]);
    }
    expect(f.counts()).toEqual({ environmentReads: 2, renewals: 2, mints: 0 });
  });
  test("confirmation gates all IO and cache remains reusable across renewed token rotation", async () => {
    const f = await fixture();
    expect((await f.run(credentialArgs)).code).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.counts().environmentReads).toBe(0);
    for (let index = 0; index < 2; index++) {
      const result = await f.run([...credentialArgs, "--confirm"]);
      expect(result.code, result.stderr).toBe(0);
      assertNoSecrets(result.stdout + result.stderr, [RENEWAL, TOKEN, KEY]);
    }
    expect(f.counts()).toEqual({ environmentReads: 2, renewals: 2, mints: 1 });
  });
  test("remote and selected nonlocal transports never inspect process or environment", async () => {
    for (const extra of [{ transport: "gateway" as const }, { transport: "daemon" as const }, { sshHost: "remote" }, { gatewayServerUrl: "https://remote.test" }, { daemonServerUrl: "https://remote.test" }]) {
      const f = await fixture();
      f.io.process = async () => { throw new Error("must not inspect process"); };
      expect(await resolveBoxRoutineAuth({ ...f.deps, ...extra }, 100)).toBeNull();
      expect(f.calls).toEqual([]);
      expect(f.counts().environmentReads).toBe(0);
    }
  });
  test("wrong owner, command, pid, or health generation never reads environment", async () => {
    for (const change of ["uid", "command", "pid", "health"]) {
      const f = await fixture();
      if (change === "uid") f.io.process = async () => ({ ...HOST, uid: 999 });
      if (change === "command") f.io.process = async () => ({ ...HOST, cmdline: "/bin/node\0/tmp/host-main.cjs\0" });
      if (change === "pid") f.deps.readFile = async () => JSON.stringify({ ...DISCOVERY, pid: -1 });
      if (change === "health") f.deps.fetch = (async () => Response.json({ pid: 123, startedAt: 2000 })) as unknown as CliDeps["fetch"];
      expect(await resolveBoxRoutineAuth(f.deps, 100)).toBeNull();
      expect(f.counts().environmentReads).toBe(0);
    }
  });
  test("process and discovery races after environment access never exchange credentials", async () => {
    for (const kind of ["process", "discovery", "proc-error"]) {
      const f = await fixture();
      let reads = 0;
      if (kind === "process") f.io.process = async () => ({ ...HOST, start: String(++reads) });
      if (kind === "proc-error") f.io.process = async () => { throw new Error(RENEWAL); };
      if (kind === "discovery") f.io.environment = async () => {
        f.deps.readFile = async () => JSON.stringify({ ...DISCOVERY, startedAt: 2000 });
        return Buffer.from(`SAND_INFERENCE_RENEWAL_CREDENTIAL=${RENEWAL}\0`);
      };
      expect(await resolveBoxRoutineAuth(f.deps, 100)).toBeNull();
      expect(f.counts().renewals).toBe(0);
    }
  });
  test("malformed and oversized credentials fail without exchange or secret errors", async () => {
    for (const raw of ["SAND_INFERENCE_RENEWAL_CREDENTIAL=\0", `SAND_INFERENCE_RENEWAL_CREDENTIAL=${"s".repeat(17000)}\0`, `SAND_INFERENCE_RENEWAL_CREDENTIAL=${RENEWAL}\nprivate\0`, "s".repeat(256 * 1024 + 1)]) {
      const f = await fixture();
      f.io.environment = async () => Buffer.from(raw);
      await expect(resolveBoxRoutineAuth(f.deps, 100)).rejects.toMatchObject({ code: "credential_invalid" });
      expect(f.counts().renewals).toBe(0);
    }
  });
  test("expired, malformed, oversized, unauthorized, unavailable and redirected renewal fail honestly", async () => {
    for (const response of [
      () => Response.json({ accessToken: TOKEN, expiresAtMs: 1000 }),
      () => Response.json({ grokBotToken: TOKEN, expiresAtMs: 100000 }),
      () => new Response(RENEWAL),
      () => new Response("x".repeat(32769)),
      () => new Response(RENEWAL, { status: 401 }),
      () => new Response(RENEWAL, { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    ]) {
      const f = await fixture();
      const fetch = f.deps.fetch;
      f.deps.fetch = (async (input, init) => new URL(String(input)).pathname === "/health" ? fetch(input, init) : response()) as CliDeps["fetch"];
      try { await resolveBoxRoutineAuth(f.deps, 100); throw new Error("unexpected success"); }
      catch (error) {
        expect(error).toMatchObject({ code: "credential_invalid" });
        assertNoSecrets(JSON.stringify(error), [RENEWAL, TOKEN]);
      }
    }
  });
  test("uncertain native mint is never automatically repeated", async () => {
    const f = await fixture();
    const fetch = f.deps.fetch;
    let mintAttempts = 0;
    f.deps.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/CreateAutomationWebhookApiKey")) {
        mintAttempts++;
        throw new Error(RENEWAL);
      }
      return fetch(input, init);
    }) as CliDeps["fetch"];
    for (let index = 0; index < 2; index++) {
      const result = await f.run([...credentialArgs, "--confirm"]);
      expect(result.code).not.toBe(0);
      assertNoSecrets(result.stdout + result.stderr, [RENEWAL, TOKEN, KEY]);
    }
    expect(mintAttempts).toBe(1);
  });
  test("a Host replaced during health cannot renew using the replacement credential", async () => {
    const f = await fixture();
    let replaced = false;
    f.io.process = async () => ({ ...HOST, start: replaced ? "200" : HOST.start });
    const fetch = f.deps.fetch;
    f.deps.fetch = (async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/health") replaced = true;
      return response;
    }) as CliDeps["fetch"];
    expect(await resolveBoxRoutineAuth(f.deps, 100)).toBeNull();
    expect(f.counts().renewals).toBe(0);
  });
  test("missing explicit expiry uses only a future JWT exp", async () => {
    const f = await fixture();
    const token = `header.${Buffer.from(JSON.stringify({ exp: 100 })).toString("base64url")}.signature`;
    const fetch = f.deps.fetch;
    f.deps.fetch = (async (input, init) => new URL(String(input)).pathname === "/health" ? fetch(input, init) : Response.json({ accessToken: token })) as CliDeps["fetch"];
    expect(await resolveBoxRoutineAuth(f.deps, 100)).toMatchObject({ token });
  });
  test("development and lab Host identities fail closed before renewal", async () => {
    for (const flags of ["", "SAND_PACKAGED=1\0SAND_LAB=1\0", "SAND_PACKAGED=1\0SAND_BOX_OWNER_NAMESPACE=dev\0"]) {
      const f = await fixture();
      f.io.environment = async () => Buffer.from(`${flags}SAND_INFERENCE_RENEWAL_CREDENTIAL=${RENEWAL}\0`);
      await expect(resolveBoxRoutineAuth(f.deps, 100)).rejects.toMatchObject({ failureCode: "renewal_namespace_unsupported" });
      expect(f.counts().renewals).toBe(0);
    }
  });
  test("unsupported Host backend never sends renewal credentials elsewhere", async () => {
    const f = await fixture();
    f.io.environment = async () => Buffer.from(`SAND_INFERENCE_RENEWAL_CREDENTIAL=${RENEWAL}\0SAND_BACKEND_URL=https://other.test\0`);
    await expect(resolveBoxRoutineAuth(f.deps, 100)).rejects.toMatchObject({ failureCode: "renewal_backend_unsupported" });
    expect(f.counts().renewals).toBe(0);
  });
  test("renewal rejection has sanitized CLI stderr and no success stdout", async () => {
    const f = await fixture();
    const fetch = f.deps.fetch;
    f.deps.fetch = (async (input, init) => new URL(String(input)).pathname === "/health" ? fetch(input, init) : new Response(RENEWAL, { status: 401 })) as CliDeps["fetch"];
    const result = await f.run(["agents", "routines", "list", "新机器人"]);
    expect(result.code).toBe(31);
    expect(result.stdout).toBe("");
    assertNoSecrets(result.stderr, [RENEWAL, TOKEN]);
    expect(parseJson(result.stderr)).toMatchObject({ error: { failureCode: "renewal_unauthorized" } });
  });
  test("cancelled renewal never exposes provider errors or retries", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.deps.signal = controller.signal;
    const fetch = f.deps.fetch;
    let attempts = 0;
    f.deps.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname === "/health") return fetch(input, init);
      attempts++;
      controller.abort();
      throw new Error(RENEWAL);
    }) as CliDeps["fetch"];
    await expect(resolveBoxRoutineAuth(f.deps, 100)).rejects.toMatchObject({ failureCode: "request_cancelled" });
    expect(attempts).toBe(1);
  });
});
