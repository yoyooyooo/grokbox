import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "../src/registry.ts";
import { parseInteger } from "../src/util.ts";
import { ioFromOpts } from "../src/opts.ts";
import {
  assertNoSecrets,
  captureCli,
  ENV_TOKEN,
  parseJson,
  startMockGateway,
  type MockGateway,
  writeDiscovery,
} from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
let mock: MockGateway | undefined;

afterEach(() => {
  mock?.stop();
  mock = undefined;
  delete process.env.SAND_GATEWAY_TOKEN;
});

function stallingFetch(_input: string, init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

describe("parseInteger strict validation", () => {
  const spec = { name: "--timeout-ms", min: 1, max: 300_000, defaultValue: DEFAULT_TIMEOUT_MS };

  test("accepts clean integer strings within range and decimal-valued integral strings", () => {
    expect(parseInteger("5", spec)).toBe(5);
    expect(parseInteger("300000", spec)).toBe(300_000);
    expect(parseInteger("30.0", spec)).toBe(30);
    expect(parseInteger("300000.0", spec)).toBe(300_000);
  });

  test("accepts scientific notation that resolves to an integer within range (parseInt stopped at e)", () => {
    expect(parseInteger("1e3", spec)).toBe(1000);
    expect(parseInteger("1E3", spec)).toBe(1000);
  });

  test("rejects fractional strings instead of silently truncating them", () => {
    expect(() => parseInteger("1.5", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("0.5", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("30.5", spec)).toThrow(/must be an integer/);
  });

  test("rejects trailing-junk strings instead of silently truncating them to the leading digits", () => {
    expect(() => parseInteger("300000abc", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("5abc", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("10;rm -rf /", spec)).toThrow(/must be an integer/);
  });

  test("rejects out-of-range values, including scientific notation that exceeds the maximum", () => {
    expect(() => parseInteger("0", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("300001", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("1e10", spec)).toThrow(/must be an integer/);
  });

  test("string and number inputs reject identically for fractions and accept identically for integers", () => {
    expect(parseInteger(5, spec)).toBe(5);
    expect(parseInteger("5", spec)).toBe(5);
    expect(() => parseInteger(1.5, spec)).toThrow(/must be an integer/);
    expect(() => parseInteger("1.5", spec)).toThrow(/must be an integer/);
    expect(() => parseInteger(NaN, spec)).toThrow(/must be an integer/);
    expect(() => parseInteger(Infinity, spec)).toThrow(/must be an integer/);
  });

  test("returns the default for undefined / null / empty and throws 'is required' without one", () => {
    expect(parseInteger(undefined, spec)).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseInteger(null, spec)).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseInteger("", spec)).toBe(DEFAULT_TIMEOUT_MS);
    const noDefault = { name: "--before-seq", min: 0, max: Number.MAX_SAFE_INTEGER };
    expect(() => parseInteger(undefined, noDefault)).toThrow(/is required/);
    expect(parseInteger("0", noDefault)).toBe(0);
  });
});

describe("ioFromOpts --timeout-ms parsing", () => {
  test("defaults to DEFAULT_TIMEOUT_MS when --timeout-ms is omitted", () => {
    expect(ioFromOpts({}).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("rejects fractional and trailing-junk --timeout-ms at the entry point", () => {
    expect(() => ioFromOpts({ timeoutMs: "1.5" })).toThrow(/--timeout-ms must be an integer/);
    expect(() => ioFromOpts({ timeoutMs: "300000abc" })).toThrow(/--timeout-ms must be an integer/);
  });
});

describe("--timeout-ms parsing end-to-end (agents list)", () => {
  async function withGateway(argv: string[], fetchOverride?: typeof fetch) {
    process.env.SAND_GATEWAY_TOKEN = ENV_TOKEN;
    mock = await startMockGateway();
    const discoveryPath = await writeDiscovery({
      port: mock.port,
      pid: mock.pid,
      startedAt: mock.startedAt,
      token: mock.token,
    });
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-util-config-"));
    const result = await captureCli(argv, {
      discoveryPath,
      skillsDir,
      configDir,
      env: {},
      ...(fetchOverride ? { fetch: fetchOverride } : {}),
      runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured in test" }),
      stdinIsTTY: true,
      readStdin: async () => "",
      now: () => 1_234,
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assertNoSecrets(JSON.stringify({ stdout: result.stdout, stderr: result.stderr, requests: mock.requests }));
    return { ...result, mock };
  }

  function errorCode(stderr: string): string {
    return (parseJson(stderr) as { error: { code: string } }).error.code;
  }

  test("fractional and trailing-junk --timeout-ms are rejected as invalid_usage before any Gateway request", async () => {
    for (const value of ["1.5", "300000abc"]) {
      const result = await withGateway(["--timeout-ms", value, "agents", "list"]);
      expect(result.code).toBe(2);
      expect(errorCode(result.stderr)).toBe("invalid_usage");
      expect(result.mock.requests).toEqual([]);
    }
  });

  test("scientific-notation --timeout-ms 1e3 is accepted and reaches the Gateway", async () => {
    const result = await withGateway(["--timeout-ms", "1e3", "agents", "list"]);
    expect(result.code).toBe(0);
    expect(result.mock.requests.map((req) => req.pathname)).toContain("/api/listAgents");
  });

  test("clean integer --timeout-ms still lists agents with no regression", async () => {
    const result = await withGateway(["--timeout-ms", "10000", "agents", "list"]);
    expect(result.code).toBe(0);
    expect(result.mock.requests.map((req) => req.pathname)).toEqual(["/api/listAgents"]);
  });

  test("a legitimate small integer --timeout-ms still aborts a stalled fetch (abort path unchanged)", async () => {
    const result = await withGateway(["--timeout-ms", "5", "agents", "list"], stallingFetch as unknown as typeof fetch);
    expect(result.code).toBe(4);
    expect(errorCode(result.stderr)).toBe("gateway_unreachable");
  });
});
