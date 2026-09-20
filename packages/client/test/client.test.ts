import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ManagementClient, ManagementClientError, RESPONSE_MAX_BYTES, botRef, type ModelChangeRequest } from "../src/client.ts";

const I = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222", OTHER = "33333333-3333-4333-8333-333333333333";
const envelope = (data: unknown) => ({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data });
const request = (): ModelChangeRequest => ({ requestId: randomUUID(), expectedRevision: "a".repeat(64), change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } });
function client(response: () => Response | Promise<Response>, installationId: string | undefined = I) {
  let calls = 0;
  const fetch = Object.assign(async () => { calls++; return await response(); }, { preconnect: () => undefined }) as typeof globalThis.fetch;
  return { client: new ManagementClient({ baseUrl: "http://127.0.0.1:37134", installationId, fetch }), calls: () => calls };
}

test("client endpoints forbid credentials, URL parameters and nonlocal plaintext", () => {
  for (const baseUrl of ["http://remote.invalid", "https://user:secret@remote.invalid", "https://remote.invalid?token=secret", "https://remote.invalid/path", "file:///tmp/anything"]) {
    expect(() => new ManagementClient({ baseUrl, installationId: I })).toThrow(ManagementClientError);
  }
});

test("unbound connections may discover identity but cannot submit business requests", async () => {
  let calls = 0;
  const unbound = new ManagementClient({ baseUrl: "http://127.0.0.1:37134", fetch: Object.assign(async () => {
    calls++;
    return Response.json(envelope({ installationId: I, principalId: "owner", capabilities: [], apiVersion: 1 }));
  }, { preconnect: () => undefined }) as typeof fetch });
  expect((await unbound.identity()).data.installationId).toBe(I);
  await expect(unbound.changeModels(request())).rejects.toMatchObject({ code: "wrong_installation" });
  expect(calls).toBe(1);
});

test("foreign Bot references and names refuse before any transport call", async () => {
  const f = client(() => { throw Error("must-not-call"); });
  await expect(f.client.bot(botRef(OTHER, A))).rejects.toMatchObject({ code: "wrong_installation" });
  await expect(f.client.bot("not-a-stable-id")).rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.client.resolveBot(`group:${I}:${A}`)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.client.resolveBot(`BOT:${I}:${A}`)).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls()).toBe(0);
});

test("read response version, HTTP status, envelope and identity are verified", async () => {
  for (const response of [
    () => Response.json({ ...envelope({}), schemaVersion: 2 }),
    () => Response.json(envelope({ selection: null, revision: "a".repeat(64) }), { status: 503 }),
    () => Response.json({ ...envelope({ selection: null, revision: "a".repeat(64) }), extra: "private-unexpected" }),
    () => Response.json(envelope({ selection: null, revision: "not-a-revision" })),
  ]) {
    const f = client(response);
    await expect(f.client.defaultModel()).rejects.toMatchObject({ code: "protocol_error" });
    expect(f.calls()).toBe(1);
  }
  const identity = client(() => Response.json(envelope({ installationId: OTHER, principalId: "owner", capabilities: [], apiVersion: 1 })));
  await expect(identity.client.identity()).rejects.toMatchObject({ code: "protocol_error" });
});

test("unverifiable mutation replies retain the original request locator and are never retried", async () => {
  for (const response of [
    () => new Response("not-json"),
    () => Response.json({ ...envelope({}), schemaVersion: 2 }),
    () => Response.json({ ...envelope({}), installationId: OTHER }),
    () => Response.json(envelope({ state: "succeeded" })),
    () => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: false, error: { code: "undeclared_error", message: "private-body" } }, { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: "https://not-authorized.invalid" } }),
    () => { throw new TypeError("private-network-diagnostic"); },
  ]) {
    const f = client(response), input = request();
    const error = await f.client.changeModels(input).then(() => null, error => error);
    expect(error).toMatchObject({ code: "operation_unknown", details: { requestId: input.requestId, installationId: I } });
    expect(error.message).not.toContain("private-");
    expect(f.calls()).toBe(1);
  }
});

test("valid domain refusal remains a refusal, not a transport replay opportunity", async () => {
  const f = client(() => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: false,
    error: { code: "revision_conflict", message: "Configuration changed." } }, { status: 409 }));
  await expect(f.client.changeModels(request())).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.calls()).toBe(1);
});

test("oversized responses are bounded and aborted before submission does not send", async () => {
  const f = client(() => new Response(" ".repeat(RESPONSE_MAX_BYTES + 1)));
  await expect(f.client.defaultModel()).rejects.toMatchObject({ code: "protocol_error" });
  const idle = client(() => { throw Error("must-not-call"); });
  await expect(idle.client.changeModels(request(), AbortSignal.abort())).rejects.toMatchObject({ code: "unavailable" });
  expect(idle.calls()).toBe(0);
});

test("credential resolution is cancellable, does not leak failures and cannot cause a late submission", async () => {
  let fetches = 0, release: ((value: string) => void) | undefined;
  const controller = new AbortController();
  const waiting = new ManagementClient({ baseUrl: "http://127.0.0.1:37134", installationId: I,
    credential: () => new Promise(resolve => { release = resolve; }),
    fetch: Object.assign(async () => { fetches++; throw new Error("must-not-submit"); }, { preconnect: () => undefined }) as typeof fetch });
  const pending = waiting.changeModels(request(), controller.signal);
  await Promise.resolve(); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  release!("late-synthetic-credential"); await Promise.resolve();
  expect(fetches).toBe(0);
  const unavailable = new ManagementClient({ baseUrl: "http://127.0.0.1:37134", installationId: I,
    credential: async () => { throw new Error("private-secret-diagnostic"); } });
  const error = await unavailable.identity().catch(error => error);
  expect(error.code).toBe("authentication_required"); expect(error.message).not.toContain("private-secret");
});

test("malformed mutation identity and revision reject before credential or transport work", async () => {
  let credentials = 0;
  const guarded = new ManagementClient({ baseUrl: "http://127.0.0.1:37134", installationId: I,
    credential: async () => { credentials++; throw Error("must-not-resolve"); } });
  await expect(guarded.changeModels({ ...request(), expectedRevision: "bad" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(guarded.changeModels({ ...request(), requestId: "bad" })).rejects.toMatchObject({ code: "invalid_input" });
  expect(credentials).toBe(0);
});

test("shared client bundles for the browser without Node, Effect, storage or provider imports", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const built = await build({ absWorkingDir: root, entryPoints: ["packages/client/src/client.ts"], bundle: true, platform: "browser",
    format: "esm", write: false, metafile: true, logLevel: "silent" });
  const inputs = Object.keys(built.metafile!.inputs);
  expect(inputs.sort()).toEqual(["packages/client/src/client.ts", "packages/client/src/context-contract.ts", "packages/client/src/context-validation.ts", "packages/client/src/contract.ts", "packages/client/src/event-watch.ts", "packages/client/src/host-health-contract.ts", "packages/client/src/incident-contract.ts", "packages/client/src/incident-validation.ts", "packages/client/src/lifecycle-contract.ts", "packages/client/src/lifecycle-validation.ts", "packages/client/src/material-validation.ts", "packages/client/src/notification-validation.ts", "packages/client/src/observation-validation.ts", "packages/client/src/protection-contract.ts", "packages/client/src/protection-validation.ts", "packages/client/src/receiver-contract.ts", "packages/client/src/receiver-validation.ts", "packages/client/src/response-validation.ts", "packages/client/src/setup-contract.ts", "packages/client/src/setup-validation.ts", "packages/runtime-kernel/src/host-health.ts", "packages/runtime-kernel/src/materials.ts"]);
  const code = built.outputFiles[0]!.text;
  expect(code).not.toMatch(/node:|bun:|from ["']effect/);
});
