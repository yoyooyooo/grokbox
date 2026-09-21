import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Effect, Fiber, ManagedRuntime, Scope } from "effect";
import { API_VERSION, ManagementClientError, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, UUID, type ApiReply, type ModelOperation, type ManagementServiceView, type Capability } from "@grokbox/client/contract";
import { ModelManagementError } from "@grokbox/runtime-kernel/model-management";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import { ManagementSourceError, modelConfigurationLayer, startMonitorService, startOpsNotificationWorker, type AutomaticNoticeWorkerStatus, type MonitorServiceStatus, type RuntimeStore } from "@grokbox/box-runtime/runtime";
import { application, type ApplicationOptions } from "./application.ts";
import type { LifecycleDomain } from "./lifecycle.ts";
import type { ContextDomain } from "./context.ts";
import { startHostHealth, type HostHealthTestPorts, startMaterialIndexer, startProtectionService, type ProtectionServiceTestPorts, type MaterialWriteHooks } from "@grokbox/box-runtime/runtime";
import { authenticate, HttpFailure, requireCapability, type AccessGrant } from "./access.ts";
import { ConsoleAuthority } from "./console-access.ts";
import { projectNotificationWorker } from "./notifications.ts";
import { shareObservationReads, watchObservationEvents, writeWatchChunk, WATCH_LIMITS } from "./event-watch.ts";
export type { AccessGrant } from "./access.ts";
export { startInstalledManagementServer, type InstalledServerOptions } from "./installed.ts";
export type { ManagementNative } from "./application.ts";

export type ManagementServerOptions = ApplicationOptions & {
  store: RuntimeStore;
  readGrants: (signal: AbortSignal) => Promise<readonly AccessGrant[]>;
  host?: "127.0.0.1" | "::1";
  port?: number;
  allowedOrigins?: readonly string[];
  maxConcurrentRequests?: number;
};
export type ManagementServer = {
  url: string;
  finished: Promise<void>;
  status: () => { state: "running" | "stopping" | "stopped" | "failed"; activeRequests: number; installationId: string; observation: MonitorServiceStatus | null; notifications: AutomaticNoticeWorkerStatus | null };
  close: () => Promise<void>;
};
const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: error => error });
function projectError(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ModelManagementError) {
    return new HttpFailure(error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "unavailable" ? 503 : error.code === "store_full" ? 507 : 409, error.code, error.message, error.details);
  }
  if (error instanceof ManagementSourceError) return new HttpFailure(error.code === "source_timeout" ? 504 : 503, error.code, error.message);
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof BoxRuntimeError) {
    const unavailable = error.code === "runtime_ownership_unavailable" || error.code === "runtime_not_ready";
    return new HttpFailure(unavailable ? 503 : error.code === "invalid_usage" ? 400 : 403,
      unavailable ? "source_unavailable" : error.code === "invalid_usage" ? "invalid_input" : "permission_denied",
      unavailable ? "Native model admission is unavailable." : error.code === "invalid_usage" ? "The model selection did not pass admission." : "Native ownership does not permit this selection.",
      { admissionCode: error.code });
  }
  return new HttpFailure(500, "internal_error", "The management request failed; inspect the service using its invocation ID.");
}
async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > REQUEST_MAX_BYTES)) throw new HttpFailure(413, "invalid_input", "The management request is too large.");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new HttpFailure(415, "invalid_input", "Management writes require application/json.");
  const chunks: Buffer[] = [];
  let total = 0;
  const cancel = () => request.destroy();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw new HttpFailure(503, "unavailable", "The service is stopping.");
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > REQUEST_MAX_BYTES) throw new HttpFailure(413, "invalid_input", "The management request is too large.");
      chunks.push(bytes);
    }
    if (signal.aborted) throw new HttpFailure(503, "unavailable", "The service is stopping.");
    try { return parseConfigJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new HttpFailure(400, "invalid_input", "The request is not strict UTF-8 JSON."); }
  } finally { signal.removeEventListener("abort", cancel); }
}
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = () => { server.removeListener("listening", ready); reject(new HttpFailure(503, "unavailable", "The management listener could not start.")); };
    const ready = () => { server.removeListener("error", error); resolve(); };
    server.once("error", error); server.once("listening", ready); server.listen(port, host);
  });
}
function closeListener(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(new Error("management_listener_cleanup_failed")) : resolve());
    server.closeAllConnections();
  });
}

/** One Effect runtime and Scope own the listener and request fibers. Client
 * disconnect does not cancel a submitted domain program; shutdown interrupts
 * observations and waits for its owned, uninterruptible commit checkpoints. */
export async function startManagementServer(options: ManagementServerOptions, testPorts: {
  notification?: Pick<NonNullable<Parameters<typeof startOpsNotificationWorker>[1]>, "request" | "idleMs" | "blockedMs">;
  materials?: NonNullable<Parameters<typeof startMaterialIndexer>[1]> & { writeHooks?: MaterialWriteHooks };
  protection?: ProtectionServiceTestPorts;
  lifecycle?: { create?: LifecycleDomain["create"] };
  context?: { hooks?: ContextDomain["hooks"] };
  hostHealth?: HostHealthTestPorts;
} = {}): Promise<ManagementServer> {
  const host = options.host ?? "127.0.0.1", port = options.port ?? 0, maxConcurrent = options.maxConcurrentRequests ?? 32;
  if (!UUID.test(options.installationId) || !["127.0.0.1", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new HttpFailure(400, "invalid_input", "Invalid management service configuration.");
  const installationId = options.installationId.toLowerCase();
  const origins = new Set<string>(), hosts = new Set<string>();
  for (const origin of options.allowedOrigins ?? []) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)))) {
      throw new HttpFailure(400, "invalid_input", "Only explicit HTTPS or local origins are allowed.");
    }
    origins.add(origin); hosts.add(parsed.host.toLowerCase());
  }
  const consoleAuthority = new ConsoleAuthority(origins);
  const runtime = ManagedRuntime.make(modelConfigurationLayer(options.store));
  let active = 0, activeWatches = 0, closing = false, stopped = false, failed = false;
  const sharedObservations = shareObservationReads(options.observations);
  let monitorService: ReturnType<typeof startMonitorService> | undefined;
  let notificationWorker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  let materialIndexer: ReturnType<typeof startMaterialIndexer> | undefined;
  let protectionService: ReturnType<typeof startProtectionService> | undefined;
  let hostHealth: ReturnType<typeof startHostHealth> | undefined;
  const hostHealthState=()=>{if(!hostHealth)throw new HttpFailure(503,"unavailable","Host health is starting.");return hostHealth.status();};
  const notificationState = () => {
    if (!notificationWorker) throw new HttpFailure(503, "unavailable", "The management process is acquiring its notification worker.");
    return projectNotificationWorker(notificationWorker.status());
  };
  const serviceState = (): ManagementServiceView => {
    const worker = monitorService?.status();
    if (!worker) throw new HttpFailure(503, "unavailable", "The management process is acquiring its observation worker.");
    return { component: "server", state: failed ? "failed" : stopped ? "stopped" : closing ? "stopping" : "running",
      observation: { owner: worker.owner, state: worker.state, reason: worker.reason, desiredRevision: worker.desiredRevision,
        collectorEpoch: worker.collectorEpoch, startedAtMs: worker.startedAtMs, lastReceiptAtMs: worker.lastReceiptAtMs,
        replacements: worker.replacements, targets: worker.targets, createsDatabase: false, notifiesDirectly: false, bootInstalled: false } };
  };
  let settled!: () => void, failFinished!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { settled = resolve; failFinished = reject; });
  void finished.catch(() => undefined);
  const reply = (response: ServerResponse, invocationId: string, value: unknown, error?: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    const failure = error === undefined ? undefined : projectError(error);
    const envelope: ApiReply<unknown> = failure ? { schemaVersion: API_VERSION, installationId, invocationId, ok: false,
      error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } }
      : { schemaVersion: API_VERSION, installationId, invocationId, ok: true, data: value };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > RESPONSE_MAX_BYTES) {
      reply(response, invocationId, undefined, new HttpFailure(503, "unavailable", "The response exceeds its bounded view; narrow the request.")); return;
    }
    if (response.headersSent) { response.end(`${body}\n`); return; }
    response.writeHead(failure?.status ?? 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(body);
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    const invocationId = randomUUID();
    request.on("error", () => undefined);
    if (closing || active >= maxConcurrent) {
      request.resume();
      response.setHeader("connection", "close");
      reply(response, invocationId, undefined, new HttpFailure(503, "unavailable", closing ? "The management service is stopping." : "The management service is at capacity.")); return;
    }
    active++;
    const handle = Effect.gen(function* () {
      yield* attempt(() => {
        if (!hosts.has((request.headers.host ?? "").toLowerCase())) throw new HttpFailure(403, "permission_denied", "The request Host is not allowed.");
        const origin = request.headers.origin;
        if (origin !== undefined && !origins.has(origin)) throw new HttpFailure(403, "permission_denied", "The request Origin is not allowed.");
        if ((request.url?.length ?? 0) > 4096) throw new HttpFailure(400, "invalid_input", "The request target is too large.");
      });
      const url = yield* attempt(() => new URL(request.url ?? "/", "http://management.invalid"));
      const grants = yield* Effect.tryPromise({ try: signal => options.readGrants(signal), catch: () => new HttpFailure(503, "unavailable", "Management access policy is unavailable.") });
      const isRedeem = url.pathname === "/v1/console/redeem" && request.method === "POST";
      const principal = yield* attempt(() => {
        if (request.headers.authorization && request.headers.cookie) throw new HttpFailure(400, "invalid_input", "Choose one authentication mechanism.");
        if (isRedeem) {
          if (request.headers.authorization) throw new HttpFailure(400, "invalid_input", "Console redemption cannot use a management bearer.");
          if (request.headers.cookie) {
            let signedIn = false;
            try { consoleAuthority.authenticate(request.headers.cookie, request.headers.origin, undefined, false, grants); signedIn = true; }
            catch (error) { if (!(error instanceof HttpFailure) || error.status !== 401) throw error; }
            if (signedIn) throw new HttpFailure(400, "invalid_input", "Sign out before redeeming another console grant.");
          }
          return undefined;
        }
        if (!request.headers.cookie) return authenticate(request.headers.authorization, grants);
        return request.headers.authorization ? authenticate(request.headers.authorization, grants)
          : consoleAuthority.authenticate(request.headers.cookie, request.headers.origin,
            typeof request.headers["x-grokbox-csrf"] === "string" ? request.headers["x-grokbox-csrf"] : undefined, request.method === "POST", grants);
      });
      yield* attempt(() => {
        const expected = request.headers["x-grokbox-installation-id"];
        if ((url.pathname !== "/v1/identity" || expected !== undefined) && expected !== installationId) throw new HttpFailure(409, "wrong_installation", "The connection is not bound to this installation.");
        if (request.method !== "GET" && request.method !== "POST") throw new HttpFailure(405, "invalid_input", "This management method is not supported.");
        if (request.method === "GET" && ((request.headers["content-length"] ?? "0") !== "0" || request.headers["transfer-encoding"] !== undefined)) throw new HttpFailure(400, "invalid_input", "Read requests cannot carry a body.");
      });
      if (request.method === "GET" && url.pathname === "/v1/observation-events/watch") {
        return yield* Effect.scoped(Effect.gen(function* () {
          const disconnected = new AbortController();
          const disconnect = () => disconnected.abort();
          yield* Effect.acquireRelease(attempt(() => {
            if (activeWatches >= Math.min(WATCH_LIMITS.subscriptions, Math.max(0, maxConcurrent - 1))) throw new HttpFailure(503, "unavailable", "The event subscription capacity is full.");
            activeWatches++; response.once("close", disconnect);
          }), () => Effect.sync(() => { activeWatches--; response.off("close", disconnect); }));
          const authorize = () => Effect.tryPromise({ try: signal => options.readGrants(signal), catch: () => new HttpFailure(503, "unavailable", "Management access policy is unavailable.") })
            .pipe(Effect.timeout("5 seconds"), Effect.flatMap(grants => attempt(() => request.headers.cookie
              ? consoleAuthority.authenticate(request.headers.cookie, request.headers.origin, undefined, false, grants)
              : authenticate(request.headers.authorization, grants))));
          yield* watchObservationEvents({ installationId, source: sharedObservations, principal: principal!, url, authorize, disconnected: disconnected.signal,
            emit: (frame, signal) => {
              if (!response.headersSent) response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
              return writeWatchChunk(response, `${JSON.stringify({ schemaVersion: API_VERSION, installationId, invocationId, ok: true, data: frame })}\n`, signal);
            } });
          response.end();
        }));
      }
      const input = request.method === "POST" ? yield* Effect.tryPromise({ try: signal => readBody(request, signal), catch: error => error })
        .pipe(Effect.timeout("15 seconds"), Effect.mapError(error => error instanceof HttpFailure ? error : new HttpFailure(408, "invalid_input", "The request body did not arrive within its deadline."))) : undefined;
      if (url.pathname.startsWith("/v1/console/")) {
        return yield* attempt(() => {
          if (url.search) throw new HttpFailure(400, "invalid_input", "Console authentication does not accept URL parameters.");
          if (isRedeem) {
            const redeemed = consoleAuthority.redeem(input, request.headers.origin, grants);
            response.setHeader("set-cookie", redeemed.cookie);
            return redeemed.data;
          }
          if (url.pathname === "/v1/console/grants" && request.method === "POST") return consoleAuthority.issue(input, principal!);
          if (url.pathname === "/v1/console/session" && request.method === "GET") return consoleAuthority.inspect(request.headers.cookie, request.headers.origin, grants);
          if (url.pathname === "/v1/console/logout" && request.method === "POST") {
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new HttpFailure(400, "invalid_input", "Logout requires an empty JSON object.");
            const result = consoleAuthority.logout(request.headers.cookie, request.headers.origin,
              typeof request.headers["x-grokbox-csrf"] === "string" ? request.headers["x-grokbox-csrf"] : undefined, grants);
            response.setHeader("set-cookie", result.cookie);
            return { signedOut: true };
          }
          throw new HttpFailure(404, "not_found", "Console authentication endpoint not found.");
        });
      }
      const materialAuthorize = async (signal: AbortSignal, capability: Capability) => {
        const current = await options.readGrants(signal);
        const fresh = request.headers.cookie ? consoleAuthority.authenticate(request.headers.cookie, request.headers.origin,
          typeof request.headers["x-grokbox-csrf"] === "string" ? request.headers["x-grokbox-csrf"] : undefined, request.method === "POST", current) : authenticate(request.headers.authorization, current);
        if (fresh.id !== principal!.id) throw new HttpFailure(403,"permission_denied","The authenticated principal changed during this request.");
        requireCapability(fresh, capability);
      };
      const result = yield* application({ ...options, installationId, serviceState, notificationState, hostHealthState,
        contextDomain: { root: options.store.root, installationId, authorize: materialAuthorize, hooks: testPorts.context?.hooks,
          ...(options.native.continuityAccess ? { context: (signal: AbortSignal) => ({ boxRuntimeRoot: options.store.root, env: options.env ?? {}, fetch: options.fetch, signal,
            gateway: () => options.native.continuityAccess!(signal), ownershipRead: options.native.ownershipRead }) } : {}) },
        lifecycleDomain: { root: options.store.root, installationId, authorize: materialAuthorize, create: testPorts.lifecycle?.create,
          ...(options.native.continuityAccess ? { context: (signal: AbortSignal) => ({ boxRuntimeRoot: options.store.root, env: options.env ?? {}, fetch: options.fetch, signal,
            gateway: () => options.native.continuityAccess!(signal), ownershipRead: options.native.ownershipRead }) } : {}) },
        protectionDomain: { root:options.store.root,installationId,status:()=>{
          if(!protectionService)throw new HttpFailure(503,"unavailable","Protection is starting.");return protectionService.status();
        },authorizeWrite:signal=>materialAuthorize(signal,"protection.write") },
        materialDomain: { root: options.store.root, installationId, status: () => {
          if (!materialIndexer) throw new HttpFailure(503,"unavailable","Material indexing is starting."); return materialIndexer.status();
        }, authorizeWrite: signal => materialAuthorize(signal,"materials.write"), writeHooks: testPorts.materials?.writeHooks },
        notificationDomain: { root: options.store.root, installationId,
          readNative: options.native.readNotificationReceiver ?? (async () => { throw new Error("notification_receiver_unavailable"); }),
          request: testPorts.notification?.request } }, principal!, request.method!, url, input);
      if (request.method === "GET" && (url.pathname === "/v1/materials" || url.pathname.startsWith("/v1/material-"))) {
        yield* Effect.tryPromise({ try: signal => materialAuthorize(signal, url.pathname.startsWith("/v1/material-operations/") ? "operations.read"
          : url.pathname.startsWith("/v1/material-content/") ? "materials.content.read" : url.searchParams.has("query") ? "materials.search" : "materials.read"), catch: error => error });
      }
      if (request.method === "GET" && (url.pathname.startsWith("/v1/contexts/") || url.pathname.startsWith("/v1/context-"))) {
        yield* Effect.tryPromise({ try: signal => materialAuthorize(signal, url.pathname.startsWith("/v1/context-operations/") || url.pathname.startsWith("/v1/context-compaction-operations/") ? "operations.read" : "context.read"), catch: error => error });
      }
      if(request.method==="GET"&&url.pathname==="/v1/host-health")yield* Effect.tryPromise({try:signal=>materialAuthorize(signal,"system.read"),catch:error=>error});
      if (request.method === "GET" && (url.pathname.startsWith("/v1/lifecycle-") || url.pathname.startsWith("/v1/handover-operations/"))) {
        yield* Effect.tryPromise({ try: signal => materialAuthorize(signal, "operations.read"), catch: error => error });
      }
      if (request.method === "GET" && (url.pathname === "/v1/protection" || url.pathname.startsWith("/v1/protection/") || url.pathname.startsWith("/v1/protection-"))) {
        yield* Effect.tryPromise({try:signal=>materialAuthorize(signal,url.pathname.startsWith("/v1/protection-operations/")?"operations.read":"protection.read"),catch:error=>error});
      }
      if (request.method === "POST" && result && typeof result === "object" && "action" in result && result.action === "test" && "state" in result && result.state === "refused") {
        return yield* Effect.fail(new HttpFailure(409, "notification_test_refused", "The independent test was not accepted. Its retained receipt describes the refusal; it does not affect permission to enable future notifications.", { operation: result }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/context-compaction") && result && typeof result === "object" && "state" in result && result.state === "failed") {
        return yield* Effect.fail(new HttpFailure(422, "compaction_failed", "The original compaction settled without success. Review its retained failure before choosing a new request.", { operation: result }));
      }
      if (request.method === "POST" && result && typeof result === "object" && "state" in result && result.state === "unknown") {
        return yield* Effect.fail(new HttpFailure(409, "operation_unknown", "The original operation requires readback; it was not replayed.", { operation: result as ModelOperation }));
      }
      return result;
    });
    void runtime.runPromise(Effect.forkIn(handle, runtime.scope).pipe(Effect.flatMap(Fiber.join))).then(
      value => reply(response, invocationId, value), error => {
        request.resume();
        if (!response.headersSent && !response.destroyed) response.setHeader("connection", "close");
        reply(response, invocationId, undefined, error);
      },
    ).finally(() => { active--; });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  server.maxConnections = 128; server.maxHeadersCount = 32; server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("close", () => {
    stopped = true;
    if (closing) settled(); else { failed = true; failFinished(new Error("management_listener_closed_unexpectedly")); }
  });
  server.on("error", () => { failed = true; failFinished(new Error("management_listener_failed")); });
  try {
    await runtime.runPromise(Effect.acquireRelease(
      Effect.tryPromise({ try: () => listen(server, host, port), catch: error => error }),
      () => Effect.promise(() => closeListener(server)),
    ).pipe(Effect.provideService(Scope.Scope, runtime.scope)));
    // Acquire sender before collector so the producer settles before sender
    // shutdown. The retained authorization and outbox still own send eligibility;
    // starting this service does not grant permission or replay old work.
    notificationWorker = await runtime.runPromise(Effect.acquireRelease(
      Effect.sync(() => startOpsNotificationWorker({ durableRoot: options.store.root,
        readNative: options.native.readNotificationReceiver ?? (async () => { throw new ManagementSourceError("source_unavailable"); }) }, testPorts.notification)),
      worker => Effect.promise(() => worker.close()),
    ).pipe(Effect.provideService(Scope.Scope, runtime.scope)));
    // The same management Scope owns acquisition and settlement. Existing
    // explicit configuration controls collection; construction never initializes
    // a database, enables notifications or adopts a native Host.
    monitorService = await runtime.runPromise(Effect.acquireRelease(
      Effect.sync(() => startMonitorService({ durableRoot: options.store.root, read: options.native.ownershipRead })),
      worker => Effect.promise(() => worker.close()),
    ).pipe(Effect.provideService(Scope.Scope, runtime.scope)));
    materialIndexer = await runtime.runPromise(Effect.acquireRelease(
      Effect.sync(() => startMaterialIndexer({ root: options.store.root, installationId }, testPorts.materials)),
      worker => Effect.promise(() => worker.close()),
    ).pipe(Effect.provideService(Scope.Scope, runtime.scope)));
    protectionService = await runtime.runPromise(Effect.acquireRelease(
      Effect.sync(()=>startProtectionService({root:options.store.root,env:options.env,fetch:options.fetch,
        ...(options.native.continuityAccess?{native:{listBots:options.native.listBots,ownershipRead:options.native.ownershipRead,continuityAccess:options.native.continuityAccess}}:{})},testPorts.protection)),
      worker=>Effect.promise(()=>worker.close()),
    ).pipe(Effect.provideService(Scope.Scope,runtime.scope)));
    hostHealth = await runtime.runPromise(Effect.acquireRelease(
      Effect.sync(()=>startHostHealth({root:options.store.root,installationId,enabled:testPorts.hostHealth?.enabled,readWitness:options.native.readHostWitness},testPorts.hostHealth)),
      worker=>Effect.promise(()=>worker.close()),
    ).pipe(Effect.provideService(Scope.Scope,runtime.scope)));
    const address = server.address();
    if (!address || typeof address === "string") throw new HttpFailure(503, "unavailable", "The management listener address is unavailable.");
    const authority = `${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    hosts.add(authority); hosts.add(`localhost:${address.port}`);
    const url = `http://${authority}`;
    origins.add(url);
    let closePromise: Promise<void> | undefined;
    return { url, finished,
      status: () => ({ state: failed ? "failed" : stopped ? "stopped" : closing ? "stopping" : "running", activeRequests: active, installationId, observation: monitorService?.status() ?? null, notifications: notificationWorker?.status() ?? null }),
      close: () => {
        closing = true;
        consoleAuthority.close();
        return closePromise ??= runtime.dispose();
      },
    };
  } catch (error) {
    closing = true;
    await runtime.dispose();
    await closeListener(server);
    throw projectError(error);
  }
}
