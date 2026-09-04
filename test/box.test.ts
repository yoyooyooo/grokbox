import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { writeProfileFile } from "../src/config/profile.ts";
import type { CliDeps } from "../src/deps.ts";
import { CURSOR_SANDBOX_BACKEND_URL } from "../src/sandbox/cursor.ts";
import { assertNoSecrets, captureCli, parseJson } from "./helpers.ts";

const ACCESS_TOKEN = "cursor-account-secret-value";
const EXEC_TOKEN_1 = "exec-secret-one";
const EXEC_TOKEN_2 = "exec-secret-two";
const NETWORK_TOKEN_1 = "network-secret-one";
const NETWORK_TOKEN_2 = "network-secret-two";
const POD_ID = "private-pod-id";
const PROFILE = "sandbox";

function envelope(flags: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(5 + payload.byteLength);
  result[0] = flags;
  result.writeUInt32BE(payload.byteLength, 1);
  payload.copy(result, 5);
  return result;
}

function execSuccess(): Response {
  return new Response(Buffer.concat([
    envelope(0, { execClientMessage: { shellResult: { success: { stdout: "", stderr: "" } } } }),
    envelope(2, {}),
  ]), { headers: { "content-type": "application/connect+json" } });
}

function parseExecBody(body: RequestInit["body"]): Record<string, unknown> {
  const bytes = Buffer.from(body as Uint8Array);
  const length = bytes.readUInt32BE(1);
  return JSON.parse(bytes.subarray(5, 5 + length).toString("utf8"));
}

function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): CliDeps["fetch"] {
  return handler as unknown as CliDeps["fetch"];
}

async function configDir(intervalMs = 1000): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-box-test-"));
  await writeProfileFile(dir, PROFILE, {
    version: 1,
    sandbox: {
      access_token_ref: "env:CURSOR_ACCESS_TOKEN",
      keepalive_interval_ms: intervalMs,
    },
  });
  return dir;
}

async function run(
  dir: string,
  argv: string[],
  overrides: Partial<CliDeps>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await captureCli(["--profile", PROFILE, ...argv], {
    configDir: dir,
    env: { CURSOR_ACCESS_TOKEN: ACCESS_TOKEN },
    ...overrides,
  });
}

describe("Cursor Sandbox control plane", () => {
  test("box status uses the read-only run-state RPC and emits no credential or descriptor", async () => {
    const dir = await configDir();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await run(dir, ["box", "status"], {
      fetch: mockFetch(async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return Response.json(
          { state: "SAND_BOX_RUN_STATE_HIBERNATED", imageUpdateAvailable: false },
          { headers: { "content-type": "application/json" } },
        );
      }),
    });

    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `${CURSOR_SANDBOX_BACKEND_URL}/aiserver.v1.GrokBotService/GetSandBoxRunState`,
    );
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.body).toBe("{}");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    const body = parseJson(result.stdout) as { data: Record<string, unknown> };
    expect(body.data.state).toBe("hibernated");
    expect(body.data.imageUpdateAvailable).toBe(false);
    expect(body.data).not.toHaveProperty("endpoint");
    assertNoSecrets(result.stdout + result.stderr, [ACCESS_TOKEN, POD_ID, EXEC_TOKEN_1, NETWORK_TOKEN_1]);
  });

  test("box wake remints a rejected exec descriptor once and reuses the no-op identity", async () => {
    const dir = await configDir();
    let ensureCalls = 0;
    const execBodies: Record<string, unknown>[] = [];
    const paths: string[] = [];
    const result = await run(dir, ["box", "wake"], {
      fetch: mockFetch(async (input, init) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith("/EnsureSandBox")) {
          ensureCalls += 1;
          return Response.json({
            execDaemonUrl: ensureCalls === 1 ? "https://exec-one.example.test" : "https://exec-two.example.test",
            execDaemonAuthToken: ensureCalls === 1 ? EXEC_TOKEN_1 : EXEC_TOKEN_2,
            networkToken: ensureCalls === 1 ? NETWORK_TOKEN_1 : NETWORK_TOKEN_2,
            podId: POD_ID,
            gatewayUrl: "https://gateway.private.example.test",
            gatewayToken: "gateway-private-token",
          }, { headers: { "content-type": "application/json" } });
        }
        expect(url.pathname).toBe("/agent.v1.ExecService/Exec");
        execBodies.push(parseExecBody(init?.body));
        expect(url.searchParams.get("network_token")).toBe(
          execBodies.length === 1 ? NETWORK_TOKEN_1 : NETWORK_TOKEN_2,
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${execBodies.length === 1 ? EXEC_TOKEN_1 : EXEC_TOKEN_2}`,
        );
        return execBodies.length === 1 ? new Response(null, { status: 401 }) : execSuccess();
      }),
    });

    expect(result.code).toBe(0);
    expect(ensureCalls).toBe(2);
    expect(execBodies).toHaveLength(2);
    expect(execBodies[0]?.exec_id).toBe(execBodies[1]?.exec_id);
    const shell = execBodies[0]?.shell_args as Record<string, unknown>;
    expect(shell.command).toBe(":");
    expect(shell.simple_commands).toEqual([":"]);
    expect(paths.some((path) => path.includes("sendPrompt"))).toBe(false);
    const output = parseJson(result.stdout) as { data: Record<string, unknown> };
    expect(output.data).toMatchObject({ woken: true, execVerified: true, descriptorRotated: true });
    assertNoSecrets(result.stdout + result.stderr, [ACCESS_TOKEN, EXEC_TOKEN_1, EXEC_TOKEN_2, NETWORK_TOKEN_1, NETWORK_TOKEN_2, POD_ID]);
  });

  test("provider auth, refusal, and protocol bodies are sanitized into stable errors", async () => {
    const dir = await configDir();
    for (const fixture of [
      { status: 401, command: ["box", "status"], code: "sandbox_unavailable", failure: "unauthorized" },
      { status: 403, command: ["box", "wake"], code: "sandbox_wake_failed", failure: "provider_refused" },
      { status: 429, command: ["box", "status"], code: "sandbox_unavailable", failure: "rate_limited" },
    ]) {
      const result = await run(dir, fixture.command, {
        fetch: mockFetch(async () => Response.json(
          { code: "private-provider-error", message: `${ACCESS_TOKEN}:${POD_ID}` },
          { status: fixture.status, headers: { "content-type": "application/json", "retry-after": "30" } },
        )),
      });
      expect(result.code).not.toBe(0);
      const body = parseJson(result.stderr) as { error: { code: string; failureCode: string } };
      expect(body.error.code).toBe(fixture.code);
      expect(body.error.failureCode).toBe(fixture.failure);
      assertNoSecrets(result.stdout + result.stderr, [ACCESS_TOKEN, POD_ID]);
    }
  });

  test("foreground keeper persists bounded redacted state and releases its lock on stop", async () => {
    const dir = await configDir();
    const controller = new AbortController();
    let ensureCalls = 0;
    let execCalls = 0;
    const result = await run(dir, ["box", "keepalive", "run", "--interval-ms", "1000"], {
      signal: controller.signal,
      wait: async () => {
        controller.abort();
        return false;
      },
      fetch: mockFetch(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/EnsureSandBox")) {
          ensureCalls += 1;
          return Response.json({
            execDaemonUrl: "https://exec.example.test",
            execDaemonAuthToken: EXEC_TOKEN_1,
            networkToken: NETWORK_TOKEN_1,
            podId: POD_ID,
          }, { headers: { "content-type": "application/json" } });
        }
        execCalls += 1;
        return execSuccess();
      }),
    });

    expect(result.code).toBe(0);
    expect(ensureCalls).toBe(1);
    expect(execCalls).toBe(1);
    const lines = result.stdout.trim().split("\n").map((line) => parseJson(line) as { data: Record<string, unknown> });
    expect(lines[0]?.data.status).toBe("healthy");
    expect(lines.at(-1)?.data).toMatchObject({ status: "stopped", running: false, tickCount: 1 });
    const root = join(dir, "run", "keepers", PROFILE);
    const stateText = await readFile(join(root, "state.json"), "utf8");
    expect((await stat(join(root, "state.json"))).mode & 0o777).toBe(0o600);
    expect(readFile(join(root, "keeper.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    assertNoSecrets(result.stdout + result.stderr + stateText, [ACCESS_TOKEN, EXEC_TOKEN_1, NETWORK_TOKEN_1, POD_ID]);

    const status = await run(dir, ["box", "keepalive", "status"], {
      fetch: mockFetch(async () => new Response()),
    });
    expect(status.code).toBe(0);
    expect((parseJson(status.stdout) as { data: Record<string, unknown> }).data).toMatchObject({
      status: "stopped",
      running: false,
      configured: true,
      tickCount: 1,
    });
  });

  test("caller cancellation wins a direct status or wake response race", async () => {
    const dir = await configDir();
    for (const command of [["box", "status"], ["box", "wake"]]) {
      const controller = new AbortController();
      const result = await run(dir, command, {
        signal: controller.signal,
        fetch: mockFetch(async () => {
          controller.abort();
          return Response.json({}, {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "120" },
          });
        }),
      });
      expect(result.code).not.toBe(0);
      expect((parseJson(result.stderr) as { error: { failureCode: string } }).error.failureCode).toBe("cancelled");
    }
  });

  test("in-flight cancellation stops without recording a synthetic provider failure", async () => {
    const dir = await configDir();
    const controller = new AbortController();
    let calls = 0;
    const result = await run(dir, ["box", "keepalive", "run"], {
      signal: controller.signal,
      fetch: mockFetch(async () => {
        calls += 1;
        controller.abort();
        return Response.json(
          { message: ACCESS_TOKEN },
          { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
        );
      }),
    });
    expect(result.code).toBe(0);
    expect(calls).toBe(1);
    const lines = result.stdout.trim().split("\n").map((line) => parseJson(line) as { data: Record<string, unknown> });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.data).toMatchObject({
      status: "stopped",
      lastFailure: null,
      tickCount: 0,
      consecutiveFailures: 0,
    });
    assertNoSecrets(result.stdout + result.stderr, [ACCESS_TOKEN]);
  });

  test("persistent 401, 429, and outage failures retain bounded cross-tick cooldowns", async () => {
    for (const fixture of [
      { status: 401, failure: "unauthorized", stopAfterWaits: 2, calls: 2, minimumCrossTickMs: 900_000 },
      { status: 429, failure: "rate_limited", stopAfterWaits: 2, calls: 2, minimumCrossTickMs: 120_000, expectedRetryDelayMs: 120_000 },
      { status: 503, failure: "provider_unavailable", stopAfterWaits: 6, calls: 6, minimumCrossTickMs: 60_000 },
    ]) {
      const dir = await configDir();
      const delays: number[] = [];
      let calls = 0;
      const result = await run(dir, ["box", "keepalive", "run", "--interval-ms", "1000"], {
        wait: async (ms) => {
          delays.push(ms);
          return delays.length < fixture.stopAfterWaits;
        },
        fetch: mockFetch(async () => {
          calls += 1;
          return Response.json({}, {
            status: fixture.status,
            headers: { "content-type": "application/json", "retry-after": "120" },
          });
        }),
      });
      expect(result.code).toBe(0);
      expect(calls).toBe(fixture.calls);
      if (fixture.expectedRetryDelayMs !== undefined) {
        expect(delays.every((delay) => delay === fixture.expectedRetryDelayMs)).toBe(true);
      }
      const states = result.stdout.trim().split("\n")
        .map((line) => (parseJson(line) as { data: Record<string, unknown> }).data)
        .filter((state) => state.status === "degraded");
      expect(states).toHaveLength(2);
      expect(states[0]?.lastFailure).toBe(fixture.failure);
      expect(states[1]?.lastFailure).toBe(fixture.failure);
      const crossTickDelays = states.map((state) =>
        Number(state.nextTickAtMs) - Number(state.lastTickAtMs));
      expect(crossTickDelays.every((delay) => delay >= fixture.minimumCrossTickMs)).toBe(true);
    }
  });

  test("HTTP-date Retry-After is persisted immediately as the cross-tick deadline", async () => {
    const dir = await configDir();
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    const delays: number[] = [];
    let calls = 0;
    const result = await run(dir, ["box", "keepalive", "run"], {
      now: () => now,
      wait: async (ms) => {
        delays.push(ms);
        return false;
      },
      fetch: mockFetch(async () => {
        calls += 1;
        return Response.json({}, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": new Date(now + 5 * 60_000).toUTCString(),
          },
        });
      }),
    });
    expect(result.code).toBe(0);
    expect(calls).toBe(1);
    expect(delays).toEqual([5 * 60_000]);
    const first = (parseJson(result.stdout.split("\n")[0]!) as { data: Record<string, unknown> }).data;
    expect(Number(first.nextTickAtMs) - Number(first.lastTickAtMs)).toBe(5 * 60_000);
    expect(first).toMatchObject({ status: "degraded", lastFailure: "rate_limited", tickCount: 1 });
  });

  test("broker body deadlines and exec body limits remain active after response headers", async () => {
    const dir = await configDir();
    let bodyCancelled = false;
    const stalled = await run(dir, ["--timeout-ms", "5", "box", "status"], {
      fetch: mockFetch(async () => new Response(new ReadableStream({
        cancel() { bodyCancelled = true; },
      }), { headers: { "content-type": "application/json" } })),
    });
    expect(stalled.code).toBe(54);
    expect((parseJson(stalled.stderr) as { error: { failureCode: string } }).error.failureCode).toBe("request_timeout");
    expect(bodyCancelled).toBe(true);

    let requests = 0;
    const oversized = await run(dir, ["box", "wake"], {
      fetch: mockFetch(async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({
            execDaemonUrl: "https://exec.example.test",
            execDaemonAuthToken: EXEC_TOKEN_1,
            networkToken: NETWORK_TOKEN_1,
            podId: POD_ID,
          }, { headers: { "content-type": "application/json" } });
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.close();
          },
        }), { headers: { "content-type": "application/connect+json" } });
      }),
    });
    expect(oversized.code).toBe(55);
    expect((parseJson(oversized.stderr) as { error: { failureCode: string } }).error.failureCode).toBe("protocol_invalid");
    assertNoSecrets(stalled.stdout + stalled.stderr + oversized.stdout + oversized.stderr, [ACCESS_TOKEN]);
  });

  test("exec parser rejects frames after a terminal frame", async () => {
    const dir = await configDir();
    let requests = 0;
    const result = await run(dir, ["box", "wake"], {
      fetch: mockFetch(async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({
            execDaemonUrl: "https://exec.example.test",
            execDaemonAuthToken: EXEC_TOKEN_1,
            networkToken: NETWORK_TOKEN_1,
            podId: POD_ID,
          }, { headers: { "content-type": "application/json" } });
        }
        return new Response(Buffer.concat([
          envelope(2, {}),
          envelope(0, { execClientMessage: { shellResult: { success: {} } } }),
        ]), { headers: { "content-type": "application/connect+json" } });
      }),
    });
    expect(result.code).toBe(55);
    expect((parseJson(result.stderr) as { error: { failureCode: string } }).error.failureCode).toBe("protocol_invalid");
  });

  test("keeper status rejects extra persisted fields instead of reflecting them", async () => {
    const dir = await configDir();
    const root = join(dir, "run", "keepers", PROFILE);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "state.json"), JSON.stringify({
      version: 1,
      profile: PROFILE,
      status: "healthy",
      running: false,
      pid: process.pid,
      startedAtMs: 1,
      updatedAtMs: 1,
      lastTickAtMs: 1,
      nextTickAtMs: null,
      tickCount: 1,
      consecutiveFailures: 0,
      lastFailure: null,
      descriptorRotated: false,
      injectedProviderBody: ACCESS_TOKEN,
    }), { mode: 0o600 });
    const result = await run(dir, ["box", "keepalive", "status"], {
      fetch: mockFetch(async () => new Response()),
    });
    expect(result.code).toBe(0);
    expect((parseJson(result.stdout) as { data: Record<string, unknown> }).data.status).toBe("never_started");
    assertNoSecrets(result.stdout + result.stderr, [ACCESS_TOKEN]);
  });

  test("keeper releases its lock when initial or final state persistence fails", async () => {
    const initialDir = await configDir();
    const initialRoot = join(initialDir, "run", "keepers", PROFILE);
    await mkdir(join(initialRoot, "state.json"), { recursive: true, mode: 0o700 });
    let initialFetches = 0;
    const initial = await run(initialDir, ["box", "keepalive", "run"], {
      fetch: mockFetch(async () => {
        initialFetches += 1;
        return new Response();
      }),
    });
    expect(initial.code).toBe(56);
    expect(initialFetches).toBe(0);
    expect(readFile(join(initialRoot, "keeper.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const finalDir = await configDir();
    const finalRoot = join(finalDir, "run", "keepers", PROFILE);
    const final = await run(finalDir, ["box", "keepalive", "run"], {
      wait: async () => {
        await rename(join(finalRoot, "state.json"), join(finalRoot, "state-before-final.json"));
        await mkdir(join(finalRoot, "state.json"), { mode: 0o700 });
        return false;
      },
      fetch: mockFetch(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/EnsureSandBox")) {
          return Response.json({
            execDaemonUrl: "https://exec.example.test",
            execDaemonAuthToken: EXEC_TOKEN_1,
            networkToken: NETWORK_TOKEN_1,
            podId: POD_ID,
          }, { headers: { "content-type": "application/json" } });
        }
        return execSuccess();
      }),
    });
    expect(final.code).toBe(56);
    expect(readFile(join(finalRoot, "keeper.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const failure = parseJson(final.stderr) as { error: { code: string; failureCode: string } };
    expect(failure.error).toMatchObject({
      code: "sandbox_keepalive_degraded",
      failureCode: "state_persistence_failed",
    });
  });

  test("keeper rejects a live duplicate before resolving credentials or contacting the provider", async () => {
    const dir = await configDir();
    const root = join(dir, "run", "keepers", PROFILE);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "keeper.lock"), JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: crypto.randomUUID(),
      startedAtMs: Date.now(),
    }), { mode: 0o600 });
    let fetches = 0;
    const result = await run(dir, ["box", "keepalive", "run"], {
      fetch: mockFetch(async () => {
        fetches += 1;
        return new Response();
      }),
    });
    expect(result.code).toBe(56);
    expect(fetches).toBe(0);
    const body = parseJson(result.stderr) as { error: { code: string; failureCode: string } };
    expect(body.error).toMatchObject({ code: "sandbox_keepalive_degraded", failureCode: "already_running" });
  });

  test("missing explicit account token capability fails without private App discovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-box-unconfigured-"));
    await writeProfileFile(dir, PROFILE, { version: 1 });
    let commands = 0;
    let fetches = 0;
    const result = await run(dir, ["box", "wake"], {
      env: {},
      runCommand: async () => {
        commands += 1;
        return { code: 0, stdout: ACCESS_TOKEN, stderr: "" };
      },
      fetch: mockFetch(async () => {
        fetches += 1;
        return new Response();
      }),
    });
    expect(result.code).toBe(22);
    expect(commands).toBe(0);
    expect(fetches).toBe(0);
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("capability_unavailable");
  });
});
