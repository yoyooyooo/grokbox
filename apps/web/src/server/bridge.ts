import { randomUUID } from "node:crypto";
import { API_VERSION, ManagementClient, ManagementClientError, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, type ApiErrorCode } from "@grokbox/client";
import type { ConsoleBootstrap } from "../lib/contracts.ts";
import { checkWebRequest, WebBoundaryError, type WebConfiguration } from "./config.ts";
import { bridgeEventStream } from "./event-stream.ts";

const readPaths = [
  /^\/v1\/handover-operations\/[a-f0-9]{64}\/[a-f0-9-]{36}$/,
  /^\/v1\/host-health$/,
  /^\/v1\/context-compactions\/[a-f0-9-]{36}$/, /^\/v1\/context-compaction-operations\/[a-f0-9]{64}\/[a-f0-9-]{36}$/,
  /^\/v1\/contexts\/[a-f0-9-]{36}$/, /^\/v1\/context-operations\/[a-f0-9]{64}\/[a-f0-9-]{36}$/,
  /^\/v1\/lifecycle-operations(?:\/[a-f0-9]{64}\/[a-f0-9-]{36})?$/,
  /^\/v1\/protection$/, /^\/v1\/protection\/bots\/[0-9a-f-]{36}$/, /^\/v1\/protection-snapshots(?:\/[^/]+)?$/, /^\/v1\/protection-handovers\/[^/]+$/,
  /^\/v1\/protection-operations\/(?:system|[0-9a-f-]{36})\/[0-9a-f-]{36}$/,
  /^\/v1\/materials$/, /^\/v1\/material-status$/, /^\/v1\/material-content\/[^/]+$/, /^\/v1\/material-operations\/[0-9a-f-]{36}$/,
  /^\/v1\/notification-settings$/, /^\/v1\/notification-blueprint\/[a-z][a-z0-9_-]{0,31}$/,
  /^\/v1\/routines(?:\/[^/]+)?$/, /^\/v1\/setup-operations\/(?:settings|routine|pairing)\/(?:installation|[0-9a-f-]{36})\/[0-9a-f-]{36}$/,
  /^\/v1\/notification-worker$/, /^\/v1\/notification-receivers$/, /^\/v1\/notification-receivers\/[^/]+(?:\/verification)?$/,
  /^\/v1\/notification-(?:receiver|test)-operations\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/, /^\/v1\/notifications(?:\/[^/]+)?$/,
  /^\/v1\/identity$/, /^\/v1\/bots$/, /^\/v1\/bots\/[^/]+$/, /^\/v1\/bots\/[^/]+\/model$/,
  /^\/v1\/models$/, /^\/v1\/models\/[^/]+$/, /^\/v1\/model-default$/,
  /^\/v1\/observation$/, /^\/v1\/observation-events$/, /^\/v1\/incidents$/, /^\/v1\/service$/,
  /^\/v1\/model-operations\/[0-9a-f-]{36}$/, /^\/v1\/console\/session$/,
];
readPaths.push(/^\/v1\/incidents\/[^/]+$/, /^\/v1\/incident-operations\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/, /^\/v1\/observation-events\/watch$/);
const writePaths = new Set(["/v1/handover-changes", "/v1/handover-continuations", "/v1/context-compactions", "/v1/context-compaction-continuations", "/v1/context-changes", "/v1/context-continuations", "/v1/protection-changes", "/v1/material-changes", "/v1/setup-changes", "/v1/model-changes", "/v1/incident-changes", "/v1/notification-receiver-changes", "/v1/notification-tests", "/v1/console/redeem", "/v1/console/logout"]);
const securityHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function consoleCookie(request: Request, origin: string): string | undefined {
  const raw = request.headers.get("cookie");
  if (!raw) return undefined;
  if (raw.length > 8192) throw new WebBoundaryError(400, "invalid_input", "The console cookie is too large.");
  const selected = raw.split(";").map(item => item.trim()).filter(item => /^(?:__Host-grokbox-console|grokbox-console-local)=/.test(item));
  if (!selected.length) return undefined;
  const name = origin.startsWith("https:") ? "__Host-grokbox-console" : "grokbox-console-local";
  if (selected.length !== 1 || !new RegExp(`^${name}=[A-Za-z0-9_-]{43}$`).test(selected[0]!)) {
    throw new WebBoundaryError(403, "permission_denied", "The console cookie does not match this origin.");
  }
  return selected[0];
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0, done = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) { done = true; break; }
      size += item.value.byteLength;
      if (size > limit) throw new WebBoundaryError(413, "invalid_input", "The console message exceeds its size bound.");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!done) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A fixed, cookie-only transport. No domain rules, token elevation, arbitrary
 * URL forwarding, CLI subprocess, native adapter or private response cache. */
export function createConsoleBridge(config: WebConfiguration, upstreamFetch: typeof fetch = globalThis.fetch) {
  let active = 0;
  function failure(status: number, code: ApiErrorCode, message: string): Response {
    return Response.json({ schemaVersion: API_VERSION, installationId: config.binding.installationId,
      invocationId: randomUUID(), ok: false, error: { code, message } }, { status, headers: securityHeaders });
  }
  async function forward(request: Request): Promise<Response> {
    let submitted = false;
    try {
      checkWebRequest(request, config);
      const url = new URL(request.url), mutation = request.method === "POST";
      if (!(mutation ? writePaths.has(url.pathname) : request.method === "GET" && readPaths.some(pattern => pattern.test(url.pathname)))) {
        throw new WebBoundaryError(404, "not_found", "This endpoint is not exposed by the console.");
      }
      if (request.headers.get("x-grokbox-installation-id") !== config.binding.installationId) {
        throw new WebBoundaryError(409, "wrong_installation", "The console request belongs to a different installation.");
      }
      if (active >= 32) throw new WebBoundaryError(503, "unavailable", "The console transport is at capacity.");
      const headers = new Headers({ accept: "application/json", origin: config.binding.origin,
        "x-grokbox-installation-id": config.binding.installationId });
      const cookie = consoleCookie(request, config.binding.origin);
      if (cookie) headers.set("cookie", cookie);
      const csrf = request.headers.get("x-grokbox-csrf");
      if (csrf) headers.set("x-grokbox-csrf", csrf);
      if (mutation && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
        throw new WebBoundaryError(415, "invalid_input", "Console writes require JSON.");
      }
      if (!mutation && (request.body || Number(request.headers.get("content-length") ?? "0") !== 0)) {
        throw new WebBoundaryError(400, "invalid_input", "Console reads cannot carry a body.");
      }
      active++;
      let streamOwned = false;
      try {
        const watching = url.pathname === "/v1/observation-events/watch";
        const deadline = AbortSignal.timeout(watching ? 70_000 : 15_000);
        const body = mutation ? await boundedBytes(request.body, REQUEST_MAX_BYTES, AbortSignal.any([deadline, request.signal])) : undefined;
        if (body) headers.set("content-type", "application/json");
        // An admitted write belongs to the management Server, not a page lifetime.
        const signal = mutation ? deadline : AbortSignal.any([deadline, request.signal]);
        signal.throwIfAborted();
        submitted = true;
        const result = await upstreamFetch(`${config.managementUrl}${url.pathname}${url.search}`, {
          method: request.method, headers, body: body as BodyInit | undefined, signal, redirect: "manual",
        });
        if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw new Error("upstream_redirect"); }
        if (watching) {
          const stream = await bridgeEventStream(result, { installationId: config.binding.installationId, cursor: url.searchParams.get("cursor") ?? "",
            limit: Number(url.searchParams.get("limit") ?? 100), signal, release: () => { active--; } });
          streamOwned = true; return stream;
        }
        const bytes = await boundedBytes(result.body, RESPONSE_MAX_BYTES, signal);
        const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (envelope?.schemaVersion !== API_VERSION || envelope?.installationId !== config.binding.installationId || envelope?.ok !== result.ok) {
          throw new Error("unverifiable_upstream");
        }
        const responseHeaders = new Headers({ ...securityHeaders, "content-type": "application/json; charset=utf-8" });
        const setCookie = result.headers.get("set-cookie");
        if (setCookie && ["/v1/console/redeem", "/v1/console/logout"].includes(url.pathname)) {
          const expected = config.binding.origin.startsWith("https:") ? "__Host-grokbox-console=" : "grokbox-console-local=";
          if (setCookie.length > 1024 || !setCookie.startsWith(expected) || /[\r\n]/.test(setCookie)) throw new Error("invalid_session_cookie");
          responseHeaders.set("set-cookie", setCookie);
        }
        return new Response(bytes as BodyInit, { status: result.status, headers: responseHeaders });
      } finally { if (!streamOwned) active--; }
    } catch (error) {
      if (submitted && ["/v1/protection-changes", "/v1/material-changes", "/v1/setup-changes", "/v1/model-changes", "/v1/incident-changes", "/v1/notification-receiver-changes", "/v1/notification-tests"].includes(new URL(request.url).pathname)) {
        return failure(503, "operation_unknown", "The response is not verifiable. Query the original request ID; do not resubmit.");
      }
      if (error instanceof WebBoundaryError) return failure(error.status, error.code, error.message);
      if (error instanceof ManagementClientError) return failure(error.code === "authentication_required" ? 401 : error.code === "permission_denied" ? 403 : error.code === "cursor_gap" ? 409 : error.code === "invalid_input" ? 400 : 503, error.code, error.message);
      return failure(503, "unavailable", "The management response is unavailable. Authentication actions must be inspected, not retried automatically.");
    }
  }
  function readClient(request: Request): ManagementClient {
    checkWebRequest(request, config);
    const cookie = consoleCookie(request, config.binding.origin);
    const transport = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== config.binding.origin || init?.method !== "GET") throw new Error("SSR is read-only and installation-bound.");
      const headers = new Headers(init.headers);
      headers.set("origin", config.binding.origin);
      if (cookie) headers.set("cookie", cookie);
      return forward(new Request(target, { ...init, headers }));
    }, { preconnect: () => undefined }) as typeof fetch;
    return new ManagementClient({ baseUrl: config.binding.origin, installationId: config.binding.installationId, console: {}, fetch: transport });
  }
  async function bootstrap(request: Request): Promise<ConsoleBootstrap> {
    checkWebRequest(request, config);
    try {
      if (!consoleCookie(request, config.binding.origin)) return { binding: config.binding, session: null };
      const { csrfToken: _csrf, ...session } = (await readClient(request).consoleSession()).data;
      return { binding: config.binding, session };
    } catch (error) {
      if (error instanceof ManagementClientError) return { binding: config.binding, session: null,
        ...(error.code === "authentication_required" ? {} : { error: { code: error.code, message: error.message } }) };
      throw error;
    }
  }
  return { forward, readClient, bootstrap, config };
}
export type ConsoleBridge = ReturnType<typeof createConsoleBridge>;
