import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile, writeProtectedSecret } from "../src/config/profile.ts";
import { captureCli, parseJson } from "./helpers.ts";

const profileName = "remote";
const endpoint = "https://box.example.ts.net:8443";
const hostname = "box.example.ts.net";
const token = "daemon-test-token";
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const skillsDir = join(import.meta.dir, "..", "skills");

type CommandFn = (
  argv: readonly string[],
  options?: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

async function remoteFixture(options: {
  fetch: typeof fetch;
  runCommand: CommandFn;
  signal?: AbortSignal;
}) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-cancel-repro-"));
  const daemonSecret = join(configDir, "secrets", "daemon");
  await writeProtectedSecret(daemonSecret, token);
  await writeProfileFile(configDir, profileName, {
    version: 1,
    transport: "daemon",
    server_url: endpoint,
    daemon_token_ref: `file:${daemonSecret}`,
    ssh_host: hostname,
  });
  return async (argv: string[]) => await captureCli(["--profile", profileName, ...argv], {
    configDir,
    env: {},
    fetch: options.fetch,
    runCommand: options.runCommand,
    skillsDir,
    stdinIsTTY: true,
    readStdin: async () => "",
    randomUUID: () => nonce,
    now: () => 1_700_000_001_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

type ErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  failureCode?: string;
  context?: { operationId?: string; phase?: string };
};

function errorBody(stderr: string): ErrorBody | null {
  if (!stderr.trim()) return null;
  return (parseJson(stderr) as { error: ErrorBody }).error;
}

describe("daemon ensure cancellation", () => {
  test("pre-aborted signal exits 26 daemon_unreachable without SSH recovery", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    let runCommandCalls = 0;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      const sig = init?.signal as AbortSignal;
      if (sig?.aborted) throw new DOMException("aborted", "AbortError");
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const runCommand: CommandFn = async () => {
      runCommandCalls += 1;
      return { code: 130, stdout: "", stderr: "Command cancelled." };
    };
    const run = await remoteFixture({ fetch: fetchFn, runCommand, signal: controller.signal });
    const result = await run(["daemon", "ensure"]);
    expect(result.code).toBe(26);
    expect(fetchCalls).toBe(1);
    expect(runCommandCalls).toBe(0);
    const err = errorBody(result.stderr)!;
    expect(err).toMatchObject({ code: "daemon_unreachable", retryable: true });
    expect(err.context).toBeUndefined();
    expect(err.failureCode).toBeUndefined();
  });

  test("abort during SSH recovery exits 26 daemon_unreachable not bootstrap_unavailable", async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    let runCommandCalls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      fetchCalls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const runCommand: CommandFn = async () => {
      runCommandCalls += 1;
      controller.abort();
      return { code: 130, stdout: "", stderr: "Command cancelled." };
    };
    const run = await remoteFixture({ fetch: fetchFn, runCommand, signal: controller.signal });
    const result = await run(["daemon", "ensure"]);
    expect(result.code).toBe(26);
    expect(fetchCalls).toBe(1);
    expect(runCommandCalls).toBe(1);
    const err = errorBody(result.stderr)!;
    expect(err).toMatchObject({ code: "daemon_unreachable", retryable: true });
    expect(err.failureCode).toBeUndefined();
    expect(err.context).toBeUndefined();
  });

  test("genuine SSH failure without abort still exits 25 bootstrap_unavailable with stamped context", async () => {
    let fetchCalls = 0;
    let runCommandCalls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      fetchCalls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const runCommand: CommandFn = async () => {
      runCommandCalls += 1;
      return { code: 1, stdout: "", stderr: "ssh: connect to host: Connection refused" };
    };
    const run = await remoteFixture({ fetch: fetchFn, runCommand });
    const result = await run(["daemon", "ensure"]);
    expect(result.code).toBe(25);
    expect(fetchCalls).toBe(1);
    expect(runCommandCalls).toBe(1);
    const err = errorBody(result.stderr)!;
    expect(err).toMatchObject({
      code: "bootstrap_unavailable",
      retryable: false,
      failureCode: "daemon_install_required",
      context: { operationId: nonce, phase: "daemon-ensure" },
    });
  });

  test("non-daemon_unreachable handshake error with pre-aborted signal propagates the original error", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      fetchCalls += 1;
      return Response.json({
        ok: true,
        result: { protocolMajor: 99 },
      });
    }) as unknown as typeof fetch;
    const runCommand: CommandFn = async () => ({ code: 0, stdout: "", stderr: "" });
    const run = await remoteFixture({ fetch: fetchFn, runCommand, signal: controller.signal });
    const result = await run(["daemon", "ensure"]);
    expect(result.code).toBe(27);
    expect(fetchCalls).toBe(1);
    const err = errorBody(result.stderr)!;
    expect(err).toMatchObject({ code: "daemon_protocol_mismatch" });
    expect(err.context).toBeUndefined();
  });
});
