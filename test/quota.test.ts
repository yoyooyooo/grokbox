import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../src/config/profile.ts";
import type { CliDeps } from "../src/deps.ts";
import { CliError } from "../src/errors.ts";
import {
  CURSOR_WEB_QUOTA_ENDPOINT,
  queryCursorWebQuota,
  quotaSnapshotFromCursorWeb,
} from "../src/quota.ts";
import { assertNoSecrets, captureCli, parseJson } from "./helpers.ts";

const nowMs = 1_700_000_000_000;
const token = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "auth0|quota-test-user", exp: nowMs / 1000 + 3600 })).toString("base64url"),
  "test-signature",
].join(".");

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hasAvailableUsage: true,
    hasNonZeroIncludedLimit: true,
    usagePercent: 25.75,
    currentPeriodStart: "2023-11-13T18:26:40Z",
    nextResetTimestampUtc: "2023-11-16T02:00:00Z",
    grokPlanLabel: "Fixture Plan",
    ...overrides,
  };
}

function fakeFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): CliDeps["fetch"] {
  return implementation as CliDeps["fetch"];
}

function deps(fetch: CliDeps["fetch"]) {
  return { fetch, now: () => nowMs, signal: undefined };
}

async function quotaProfile(configDir: string): Promise<void> {
  await writeProfileFile(configDir, "quota", {
    version: 1,
    quota: { source: "cursor-web", access_token_ref: "env:QUOTA_ACCESS_TOKEN" },
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CliError ? error.code : undefined;
}

describe("Cursor web quota adapter", () => {
  test("sends one fixed bounded request and returns only the sanitized fresh DTO", async () => {
    let calls = 0;
    let observed: { url: string; init: RequestInit } | undefined;
    const snapshot = await queryCursorWebQuota(
      deps(fakeFetch(async (input, init) => {
        calls += 1;
        observed = { url: String(input), init: init ?? {} };
        return Response.json(payload({
          accountEmail: "must-not-escape@example.test",
          accessToken: "must-not-escape",
          usageEvents: [{ content: "must-not-escape" }],
        }));
      })),
      token,
      1_000,
    );

    expect(calls).toBe(1);
    expect(observed?.url).toBe(CURSOR_WEB_QUOTA_ENDPOINT);
    expect(observed?.init.method).toBe("POST");
    expect(observed?.init.body).toBe("{}");
    expect(observed?.init.cache).toBe("no-store");
    expect(observed?.init.redirect).toBe("manual");
    const headers = new Headers(observed?.init.headers);
    expect(headers.get("origin")).toBe("https://cursor.com");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("cookie")).toStartWith("WorkosCursorSessionToken=quota-test-user%3A%3A");
    expect(snapshot).toEqual({
      hasAvailableUsage: true,
      hasIncludedLimit: true,
      usedPercent: 25.75,
      remainingPercent: 74.25,
      periodStart: "2023-11-13T18:26:40.000Z",
      resetsAt: "2023-11-16T02:00:00.000Z",
      plan: "Fixture Plan",
      fetchedAt: "2023-11-14T22:13:20.000Z",
      freshness: "fresh",
      source: "cursor-web",
      accountBinding: "source-local",
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("must-not-escape");
    expect(serialized).not.toContain("quota-test-user");
    expect(serialized).not.toContain(token);
  });

  test("does not invent percentages when the provider reports no included limit", () => {
    expect(quotaSnapshotFromCursorWeb(payload({
      hasAvailableUsage: false,
      hasNonZeroIncludedLimit: false,
      usagePercent: 0,
    }), nowMs)).toMatchObject({
      hasAvailableUsage: false,
      hasIncludedLimit: false,
      usedPercent: null,
      remainingPercent: null,
    });
  });

  test("keeps the deadline active while reading the bounded response body", async () => {
    const stalled = queryCursorWebQuota(
      deps(fakeFetch(async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      })))),
      token,
      5,
    );
    const error = await stalled.catch((failure) => failure);
    expect(errorCode(error)).toBe("quota_provider_unavailable");
    expect((error as CliError).failureCode).toBe("request_timeout");
  });

  test("rejects malformed, expired, unauthorized, oversized, and unavailable responses", async () => {
    let calls = 0;
    const malformedToken = queryCursorWebQuota(
      deps(fakeFetch(async () => {
        calls += 1;
        return Response.json(payload());
      })),
      "not-a-jwt",
      1_000,
    );
    expect(errorCode(await malformedToken.catch((error) => error))).toBe("quota_authorization_failed");
    expect(calls).toBe(0);

    const expired = [token.split(".")[0], Buffer.from(JSON.stringify({ sub: "auth0|x", exp: 1 })).toString("base64url"), "sig"].join(".");
    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => Response.json(payload()))), expired, 1_000).catch((error) => error)))
      .toBe("quota_authorization_failed");

    let redirectCalls = 0;
    const redirectError = await queryCursorWebQuota(deps(fakeFetch(async () => {
      redirectCalls += 1;
      return new Response("", { status: 302, headers: { location: "https://unexpected.example" } });
    })), token, 1_000).catch((error) => error);
    expect(errorCode(redirectError)).toBe("quota_protocol_unsupported");
    expect((redirectError as CliError).failureCode).toBe("redirect_refused");
    expect(redirectCalls).toBe(1);

    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => new Response("", { status: 401 }))), token, 1_000).catch((error) => error)))
      .toBe("quota_authorization_failed");
    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => new Response("", { status: 503 }))), token, 1_000).catch((error) => error)))
      .toBe("quota_provider_unavailable");
    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => new Response("x".repeat(64 * 1024 + 1)))), token, 1_000).catch((error) => error)))
      .toBe("quota_protocol_unsupported");
    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => Response.json(payload({ usagePercent: Number.NaN })))), token, 1_000).catch((error) => error)))
      .toBe("quota_protocol_unsupported");
    expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => Response.json(payload({ grokPlanLabel: "plan\u001b[2Jspoof\nrow" })))), token, 1_000).catch((error) => error)))
      .toBe("quota_protocol_unsupported");
    for (const invalidTimestamp of ["2023-02-29T00:00:00Z", "2023-04-31T00:00:00Z"]) {
      expect(errorCode(await queryCursorWebQuota(deps(fakeFetch(async () => Response.json(payload({ currentPeriodStart: invalidTimestamp })))), token, 1_000).catch((error) => error)))
        .toBe("quota_protocol_unsupported");
    }
  });
});

describe("quota command", () => {
  test("uses only the Profile-declared quota source and supports JSON and table output", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-quota-test-"));
    await quotaProfile(configDir);
    const urls: string[] = [];
    let commandCalls = 0;
    const common = {
      configDir,
      discoveryPath: "/must-not-be-read/gateway.json",
      env: { QUOTA_ACCESS_TOKEN: token },
      now: () => nowMs,
      fetch: fakeFetch(async (input) => {
        urls.push(String(input));
        return Response.json(payload());
      }),
      runCommand: async () => {
        commandCalls += 1;
        return { code: 1, stdout: "", stderr: "must-not-run" };
      },
    };
    const json = await captureCli(["--profile", "quota", "quota"], common);
    expect(json.code).toBe(0);
    const result = parseJson(json.stdout) as { data: Record<string, unknown> };
    expect(result.data.source).toBe("cursor-web");
    expect(result.data.freshness).toBe("fresh");
    assertNoSecrets(json.stdout + json.stderr, [token]);

    const table = await captureCli(["--profile", "quota", "--table", "quota"], common);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("remainingPercent");
    expect(table.stdout).not.toContain(token);
    expect(urls).toEqual([CURSOR_WEB_QUOTA_ENDPOINT, CURSOR_WEB_QUOTA_ENDPOINT]);
    expect(commandCalls).toBe(0);
  });

  test("fails closed before fetch when the selected Profile has no explicit quota source", async () => {
    let calls = 0;
    const result = await captureCli(["quota"], {
      fetch: fakeFetch(async () => {
        calls += 1;
        return Response.json(payload());
      }),
    });
    expect(result.code).toBe(60);
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("quota_unavailable");
    expect(calls).toBe(0);
  });

  test("fails closed in-box without scraping sandbox, discovery, SSH, or host APIs", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-quota-local-"));
    await writeProfileFile(configDir, "boxed", {
      version: 1,
      ssh_host: "remote",
      sandbox: { access_token_ref: "env:SANDBOX_ACCESS_TOKEN" },
    });
    let fetches = 0;
    let commands = 0;
    const reads: string[] = [];
    const result = await captureCli(["--profile", "boxed", "quota"], {
      configDir,
      discoveryPath: "/must-not-be-read/gateway.json",
      env: { SANDBOX_ACCESS_TOKEN: "sandbox-secret-must-not-be-used" },
      readFile: async (path) => {
        reads.push(path);
        throw new Error(`must-not-read:${path}`);
      },
      fetch: fakeFetch(async () => {
        fetches += 1;
        return Response.json(payload());
      }),
      runCommand: async () => {
        commands += 1;
        return { code: 1, stdout: "", stderr: "must-not-run" };
      },
    });
    expect(result.code).toBe(60);
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("quota_unavailable");
    expect(fetches).toBe(0);
    expect(commands).toBe(0);
    expect(reads).toEqual([]);
    assertNoSecrets(result.stdout + result.stderr, ["sandbox-secret-must-not-be-used"]);
  });
});
