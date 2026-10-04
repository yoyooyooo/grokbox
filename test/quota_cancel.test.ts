import { describe, expect, test } from "bun:test";
import type { CliDeps } from "../src/deps.ts";
import { CliError } from "../src/errors.ts";
import { queryCursorWebQuota } from "../src/quota.ts";

const nowMs = 1_700_000_000_000;
const token = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "auth0|quota-test-user", exp: nowMs / 1000 + 3600 })).toString("base64url"),
  "test-signature",
].join(".");

function fakeFetch(fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): CliDeps["fetch"] {
  return fn as CliDeps["fetch"];
}

function stalledStreamResponse(init?: RequestInit): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    }),
  );
}

function quotaDeps(
  fetch: CliDeps["fetch"],
  signal?: AbortSignal,
): Pick<CliDeps, "fetch" | "now" | "signal"> {
  return { fetch, now: () => nowMs, ...(signal === undefined ? {} : { signal }) };
}

function failureCode(error: unknown): string | undefined {
  return error instanceof CliError ? error.failureCode : undefined;
}

describe("queryCursorWebQuota caller-cancel distinct from timeout", () => {
  test("caller-signal abort mid-body-read is attributed as cancelled, not request_timeout", async () => {
    const caller = new AbortController();
    const deps = quotaDeps(fakeFetch(async (_input, init) => stalledStreamResponse(init)), caller.signal);
    const promise = queryCursorWebQuota(deps, token, 1_000);
    setTimeout(() => caller.abort(), 10);
    const error = (await promise.catch((f) => f)) as CliError;
    expect(error.code).toBe("quota_provider_unavailable");
    expect(error.failureCode).toBe("cancelled");
    expect(error.retryable).toBe(true);
  });

  test("caller-signal abort mid-fetch is attributed as cancelled via the fetch catch", async () => {
    const caller = new AbortController();
    const deps = quotaDeps(
      fakeFetch(async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ),
      caller.signal,
    );
    const promise = queryCursorWebQuota(deps, token, 1_000);
    setTimeout(() => caller.abort(), 10);
    const error = (await promise.catch((f) => f)) as CliError;
    expect(error.code).toBe("quota_provider_unavailable");
    expect(error.failureCode).toBe("cancelled");
    expect(error.retryable).toBe(true);
  });

  test("a pre-aborted caller signal is attributed as cancelled via the fetch catch", async () => {
    let calls = 0;
    const caller = new AbortController();
    caller.abort();
    const deps = quotaDeps(
      fakeFetch(async (_input, init) => {
        calls += 1;
        if (init?.signal?.aborted) throw new Error("aborted");
        return new Response("{}");
      }),
      caller.signal,
    );
    const error = (await queryCursorWebQuota(deps, token, 1_000).catch((f) => f)) as CliError;
    expect(error.code).toBe("quota_provider_unavailable");
    expect(error.failureCode).toBe("cancelled");
    expect(error.retryable).toBe(true);
    expect(calls).toBe(1);
  });

  test("a non-abort network failure is still attributed as network_failure", async () => {
    const deps = quotaDeps(fakeFetch(async () => {
      throw new TypeError("network down");
    }));
    const error = (await queryCursorWebQuota(deps, token, 1_000).catch((f) => f)) as CliError;
    expect(error.code).toBe("quota_provider_unavailable");
    expect(failureCode(error)).toBe("network_failure");
  });
});

describe("queryCursorWebQuota unrelated failures are not misattributed as cancellation", () => {
  test("a 503 provider refusal keeps failureCode provider_refused even with a caller signal present", async () => {
    const caller = new AbortController();
    const deps = quotaDeps(
      fakeFetch(async () => new Response("", { status: 503 })),
      caller.signal,
    );
    const error = (await queryCursorWebQuota(deps, token, 1_000).catch((f) => f)) as CliError;
    expect(error.code).toBe("quota_provider_unavailable");
    expect(error.failureCode).toBe("provider_refused");
    expect(error.httpStatus).toBe(503);
    expect(caller.signal.aborted).toBe(false);
  });
});
