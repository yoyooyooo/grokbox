import { describe, expect, spyOn, test } from "bun:test";
import * as dns from "node:dns";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { FAKE_BINDING, modeldFixture, submitRequest } from "./modeld-fixture.ts";
import { createContext, runInContext } from "node:vm";
import { BoxRuntimeError } from "../src/errors.ts";
import { eventsPath } from "../src/paths.ts";
import { bindHostSessionHook, createModeldRouteDriver, createSessionSeam } from "../src/seam.ts";
import {
  callStubModeld,
  encodeModeldFrame,
  modeldSocketPath,
  probeStubModeld,
  startStubModeldServer,
  STUB_ECHO_MODEL_ID,
} from "../src/modeld-ipc.ts";
import { applyPatchProfile, profileFromSource, ROUTE_SESSION_SYMBOL } from "../src/transform.ts";
import { createManagedPromptSession, type HostPromptSession, type PromptSession } from "../src/session.ts";
import {
  collectStreamParts,
  consumeHostSession as consumeHost,
  duplicateHostStream,
  hasMeaningfulResponseMessageContent,
  SEAM_STOP_PARTS,
} from "./host-consumer.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const AT = "2026-01-01T00:00:00.000Z";

function isUnixSocketConnect(args: unknown[]): boolean {
  const flat = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
  for (const arg of flat) {
    if (typeof arg === "string" && (arg.startsWith("/") || arg.endsWith(".sock"))) return true;
    if (arg && typeof arg === "object" && "path" in arg) {
      const path = (arg as { path?: unknown }).path;
      if (typeof path === "string" && path.length > 0) return true;
    }
  }
  return false;
}

function installNetworkTraps(counts: { fetch: number; dns: number; tcp: number }): () => void {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const denyFetch = (..._args: unknown[]): never => { counts.fetch += 1; throw new Error("provider fetch hard-off"); };
  const denyDns = (..._args: unknown[]): never => { counts.dns += 1; throw new Error("provider DNS hard-off"); };
  const lookup = Object.assign(denyDns, { __promisify__: denyDns });
  globalThis.fetch = Object.assign(denyFetch, { preconnect: denyFetch });
  const spies = [
    spyOn(dns, "lookup").mockImplementation(lookup),
    spyOn(dns, "resolve").mockImplementation(lookup),
    spyOn(dns, "resolve4").mockImplementation(lookup),
    spyOn(dns, "resolve6").mockImplementation(lookup),
    spyOn(dns.promises, "lookup").mockImplementation(denyDns),
    spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: never[]) {
      if (!isUnixSocketConnect(args)) { counts.tcp += 1; throw new Error("provider TCP hard-off"); }
      return originalConnect.apply(this, args as never);
    }),
  ];
  return () => { globalThis.fetch = originalFetch; for (const spy of spies) spy.mockRestore(); };
}

const roots = modeldFixture;
async function canaryRoots(agentId = "agent-tom") {
  const f = await modeldFixture();
  await f.store.saveModels({
    version: 1,
    models: {},
    assignments: { main: null, agents: { [agentId]: STUB_ECHO_MODEL_ID } },
  });
  return f;
}

async function turnLines(dir: string): Promise<Array<Record<string, unknown>>> {
  let text = "";
  try {
    text = await readFile(eventsPath(dir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.name === "model_step_terminal" || row.name === "host_stream_rejected");
}

function officialSession(): PromptSession {
  return createManagedPromptSession({
    modelId: "official-main",
    vision: false,
    parallel: "allow",
    parts: SEAM_STOP_PARTS,
  });
}

function loadSynthetic(hook: (args: { originalSession: object; sessionOptions?: unknown; agentId?: string }) => unknown) {
  const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
  const transformed = applyPatchProfile(SYNTHETIC_HOST, profile);
  if (!transformed.ok) throw new Error(transformed.code);
  const module = {
    exports: {} as {
      createSession: (sessionOptions: unknown) => { kind: string };
      runTurn: (host: { getConversationId: () => string }) => { kind: string };
    },
  };
  const sandbox = createContext({
    module,
    exports: module.exports,
    Symbol,
    hook,
  });
  runInContext(`globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")] = hook;\n${transformed.source}`, sandbox);
  return module.exports;
}

describe("stub route synthetic compile/load", () => {
  test("identity returns the official object, skips modeld, and writes no seam event", async () => {
    const { durable, runRoot } = await roots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const original = officialSession();
      const hook = bindHostSessionHook({ mode: "identity", durableRoot: durable, runRoot, binding: FAKE_BINDING });
      const returned = hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-id", agentId: "agent-tom", inferenceReason: "main" },
        agentId: "agent-tom",
      });
      expect(returned).toBe(original);
      const loaded = loadSynthetic(hook);
      const session = loaded.runTurn({ getConversationId: () => "agent-tom" });
      expect(session.kind).toBe("official-session");
      expect(session).toBe(session);
      expect(server.dispatches()).toBe(0);
      expect(await turnLines(durable)).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("route ordinary-main is managed; non-main stays official", async () => {
    const { durable, runRoot } = await canaryRoots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const original = officialSession();
      const hook = bindHostSessionHook({ mode: "route", durableRoot: durable, runRoot, binding: FAKE_BINDING });
      const managed = hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-main", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      expect(managed).not.toBe(original);
      const executor = managed.getExecutor([]);
      expect(Array.isArray(executor.getMessages())).toBe(true);
      expect(Array.isArray(executor.getState())).toBe(true);
      const loaded = loadSynthetic(hook);
      const main = loaded.runTurn({ getConversationId: () => "agent-tom" });
      expect(main).not.toBe(loaded.createSession({ inferenceReason: "computer" }));
      const computer = loaded.createSession({ inferenceReason: "computer" });
      expect(computer.kind).toBe("official-session");
      const vector = await consumeHost(managed, "inv-main");
      expect(vector.toolExecutionCount).toBe(0);
      expect(vector.finalDeliveryCount).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("route executor stream is synchronous, Host-shaped, and does not tee waiters", async () => {
    const { durable, runRoot } = await canaryRoots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const original = officialSession();
      const hook = bindHostSessionHook({ mode: "route", durableRoot: durable, runRoot, binding: FAKE_BINDING });
      const managed = hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-shape", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      const executor = managed.getExecutor([]);
      executor.appendMessages({ role: "user", content: "ping" });
      expect(executor.getMessages()).toEqual([{ role: "user", content: "ping" }]);
      executor.clearMessages();
      expect(executor.getState()).toEqual([]);
      const result = executor.stream({}, "inv-shape", [], {});
      expect(result).not.toBeInstanceOf(Promise);
      expect("then" in result).toBe(false);
      const response = await result.response;
      expect(response.modelId.trim()).toBe(STUB_ECHO_MODEL_ID);
      expect(response.messages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "echo" }] },
      ]);
      expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
      expect(await result.usage).toEqual({
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      });
      const fromStream: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") fromStream.push(part.textDelta);
      }
      expect(fromStream).toEqual([]);
      expect(await result.extendedUsage).toMatchObject({ inputTokens: 1, outputTokens: 1, maxTokens: 0 });
      expect(await result.invocationId).toBe("inv-shape");

      const missing = hook({
        originalSession: original,
        sessionOptions: { inferenceReason: "main" },
        agentId: "agent-tom",
      });
      expect(missing).toBe(original);
    } finally {
      await server.stop();
    }
  });

  test("response-only route reaches a meaningful response before duplicateStream's second reader attaches",
    async () => {
    const { durable, runRoot } = await canaryRoots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const original = officialSession();
      const hook = bindHostSessionHook({ mode: "route", durableRoot: durable, runRoot, binding: FAKE_BINDING });
      const managed = hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-dup", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      const result = managed.getExecutor().stream({}, "inv-dup", [], {});
      expect(result).not.toBeInstanceOf(Promise);
      expect("then" in result).toBe(false);

      const [inner, late] = duplicateHostStream(result.fullStream);
      const [innerParts, response] = await Promise.all([
        collectStreamParts(inner),
        result.response,
      ]);
      expect(innerParts).toEqual([]);

      // Attach the second fork only after the Host can settle its model response.
      const fullParts = await collectStreamParts(late);
      expect(fullParts).toEqual([]);
      expect(response.messages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "echo" }] },
      ]);
      expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
      expect(await result.invocationId).toBe("inv-dup");
    } finally {
      await server.stop();
    }
  });
});

describe("stub modeld IPC", () => {
  test("one text submit dispatches once and writes one terminal; duplicate stream does not", async () => {
    const { durable, runRoot } = await roots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const driver = createModeldRouteDriver(runRoot, FAKE_BINDING);
      expect(() => driver.resolveCredential()).toThrow(/credential/);
      expect(() => driver.openNetwork()).toThrow(/network/);
      const seam = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver,
        now: () => AT,
      });
      const original = officialSession();
      const args = {
        originalSession: original,
        sessionOptions: { invocationId: "inv-text", inferenceReason: "main" },
        agentId: "agent-tom",
      };
      const first = seam.hook(args) as HostPromptSession;
      expect(first).not.toBe(original);
      await consumeHost(first, "inv-text");
      first.getExecutor().stream({}, "inv-text");
      const second = seam.hook(args);
      expect(second).toBe(first);
      await consumeHost(second as HostPromptSession, "inv-text");
      await seam.flush();
      expect(driver.dispatches).toBe(1);
      expect(server.dispatches()).toBe(1);
      expect(driver.officialCalls).toBe(0);
      expect(driver.secondProviderCalls).toBe(0);
      const events = await turnLines(durable);
      expect(events).toEqual([
        expect.objectContaining({
          name: "model_step_terminal",
          schemaVersion: 2,
          at: AT,
          mode: "route",
          agentId: "agent-tom",
          assignment: "main",
          modelId: STUB_ECHO_MODEL_ID,
          turnId: "inv-text",
          invocationId: "inv-text",
          toolCallCount: 0,
          terminalClass: "stop",
          outcome: "managed",
          stage: "host-normalize",
          admission: "new",
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  test("conflicting duplicate invocation ids fail closed at the seam", async () => {
    const { durable, runRoot } = await roots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const driver = createModeldRouteDriver(runRoot, FAKE_BINDING);
      const seam = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver,
        now: () => AT,
      });
      const original: PromptSession = {
        stream() {
          throw new Error("official session must not run");
        },
      };
      const first = seam.hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-conflict-seam", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      const second = seam.hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-conflict-seam", inferenceReason: "main" },
        agentId: "agent-jerry",
      }) as HostPromptSession;
      expect(second).not.toBe(first);
      await consumeHost(first, "inv-conflict-seam");
      await consumeHost(second, "inv-conflict-seam");
      await seam.flush();
      expect(second).not.toBe(first);
      expect(driver.officialCalls).toBe(0);
      expect(driver.secondProviderCalls).toBe(0);
      expect(driver.dispatches).toBe(1);
      const events = await turnLines(durable);
      expect(events).toEqual([
        expect.objectContaining({
          invocationId: "inv-conflict-seam",
          agentId: "agent-tom",
          outcome: "managed",
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  test("failure matrix stays closed with no official or second driver", async () => {
    const { durable, runRoot } = await roots();
    const original: PromptSession = {
      stream() {
        throw new Error("official session must not run");
      },
    };

    const downDriver = createModeldRouteDriver(runRoot, FAKE_BINDING);
    const downSeam = createSessionSeam({
      mode: "route",
      root: durable,
      assignment: "main",
      modelId: STUB_ECHO_MODEL_ID,
      driver: downDriver,
      now: () => AT,
    });
    const downSession = downSeam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-down", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const downError = (await downSession.getExecutor([]).stream({}, "inv-down").response).error;
    expect(downError).toMatchObject({
      userVisible: true,
      agentId: "agent-tom",
      invocationId: "inv-down",
      stage: "admit",
    });
    expect(downError?.message).toContain("agentId=agent-tom");
    expect(downError?.message).toContain("invocationId=inv-down");
    expect(downError?.message).toContain("stage=admit");
    await downSeam.flush();
    expect(downDriver.officialCalls).toBe(0);
    expect(downDriver.secondProviderCalls).toBe(0);

    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      const malformed = await new Promise<Buffer>((resolve, reject) => {
        const socket = net.createConnection({ path: modeldSocketPath(runRoot) });
        socket.on("error", reject);
        socket.on("connect", () => socket.write(Buffer.from([0, 0, 0, 3, 123, 1, 2])));
        socket.on("data", (chunk: Buffer) => {
          socket.end();
          resolve(chunk);
        });
      });
      expect(malformed.length).toBeGreaterThan(4);

      const wrong = await callStubModeld(runRoot, { ...submitRequest(server, "inv-wrong"), modelId: "acme/fast" });
      expect(wrong).toMatchObject({ ok: false, code: "excess-fields" });

      const missing = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver: createModeldRouteDriver(runRoot, FAKE_BINDING),
        now: () => AT,
      });
      const missingSession = missing.hook({
        originalSession: original,
        sessionOptions: { inferenceReason: "main" },
        agentId: "agent-tom",
      });
      expect(missingSession).toBe(original);
      expect(server.dispatches()).toBe(0);

      const first = await callStubModeld(runRoot, submitRequest(server, "inv-conflict"));
      expect(first).toMatchObject({ ok: true, dispatched: true });
      const conflict = await callStubModeld(runRoot, submitRequest(server, "inv-conflict", { agentId: "agent-jerry" }));
      expect(conflict).toMatchObject({ ok: false, code: "conflict" });

      await callStubModeld(runRoot, { method: "disconnect", serverGeneration: server.serverGeneration, host: FAKE_BINDING, invocationId: "inv-gone" });
      const disconnected = await callStubModeld(runRoot, submitRequest(server, "inv-gone"));
      expect(disconnected).toMatchObject({ ok: false, code: "disconnected" });

      const abortDriver = createModeldRouteDriver(runRoot, FAKE_BINDING);
      const abortSeam = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver: abortDriver,
        now: () => AT,
      });
      const abortSession = abortSeam.hook({
        originalSession: original,
        sessionOptions: { invocationId: "inv-abort", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      const controller = new AbortController();
      controller.abort();
      abortSession.getExecutor().stream(undefined, "inv-abort", undefined, { abortSignal: controller.signal });
      await abortSeam.flush();
      expect(abortDriver.officialCalls).toBe(0);
      expect(server.dispatches()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("hard-off: no credential resolver, fetch, DNS, or TCP while unix IPC works", async () => {
    const { durable, runRoot } = await roots();
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    const counts = { fetch: 0, dns: 0, tcp: 0 };
    const restore = installNetworkTraps(counts);
    try {
      const driver = createModeldRouteDriver(runRoot, FAKE_BINDING);
      const seam = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver,
        now: () => AT,
      });
      const managed = seam.hook({
        originalSession: officialSession(),
        sessionOptions: { invocationId: "inv-hardoff", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      await consumeHost(managed, "inv-hardoff");
      await seam.flush();
      expect(driver.dispatches).toBe(1);
      expect(() => driver.resolveCredential()).toThrow(/credential/);
      expect(counts.fetch).toBe(0);
      expect(counts.dns).toBe(0);
      expect(counts.tcp).toBe(0);
      const payload = JSON.stringify(
        await callStubModeld(runRoot, submitRequest(server, "inv-hardoff-2")),
      );
      expect(payload).not.toMatch(/https?:|apiKey|sk-|ACME_|env:/);
      expect(encodeModeldFrame({ method: "health" }).includes(Buffer.from("https://"))).toBe(false);
      expect(counts.fetch).toBe(0);
      expect(counts.dns).toBe(0);
      expect(counts.tcp).toBe(0);

      await server.stop();
      const downDriver = createModeldRouteDriver(runRoot, FAKE_BINDING);
      const downSeam = createSessionSeam({
        mode: "route",
        root: durable,
        assignment: "main",
        modelId: STUB_ECHO_MODEL_ID,
        driver: downDriver,
        now: () => AT,
      });
      const downSession = downSeam.hook({
        originalSession: officialSession(),
        sessionOptions: { invocationId: "inv-hardoff-down", inferenceReason: "main" },
        agentId: "agent-tom",
      }) as HostPromptSession;
      await consumeHost(downSession, "inv-hardoff-down");
      await downSeam.flush();
      expect(downDriver.officialCalls).toBe(0);
      expect(downDriver.secondProviderCalls).toBe(0);
      expect(counts.fetch).toBe(0);
      expect(counts.dns).toBe(0);
      expect(counts.tcp).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("stub modeld socket ownership", () => {
  test("refuses a live competitor and stop unlinks only the owned socket", async () => {
    const { runRoot, durable } = await roots();
    const socketPath = modeldSocketPath(runRoot);
    const first = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      await expect(startStubModeldServer({ runRoot, durableRoot: durable })).rejects.toMatchObject({
        code: "invalid_usage",
      });
      expect(await probeStubModeld(runRoot)).toBe(true);
      const owned = await lstat(socketPath);
      await unlink(socketPath);
      await writeFile(socketPath, "not-ours");
      const replacement = await lstat(socketPath);
      expect(replacement.ino).not.toBe(owned.ino);
      await first.stop();
      const leftover = await lstat(socketPath);
      expect(leftover.ino).toBe(replacement.ino);
      expect(await probeStubModeld(runRoot)).toBe(false);
    } finally {
      await first.stop();
      await unlink(socketPath).catch(() => undefined);
    }
  });

  test("stale socket is replaced; live health remains after a refused second start", async () => {
    const { runRoot, durable } = await roots();
    const socketPath = modeldSocketPath(runRoot);
    const orphanPath = `${socketPath}.orphan`;
    const orphan = net.createServer();
    await new Promise<void>((resolve) => orphan.listen(orphanPath, resolve));
    await rename(orphanPath, socketPath);
    await new Promise<void>((resolve) => orphan.close(() => resolve()));
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    const server = await startStubModeldServer({ runRoot, durableRoot: durable });
    try {
      expect(await probeStubModeld(runRoot)).toBe(true);
      await expect(startStubModeldServer({ runRoot, durableRoot: durable })).rejects.toBeInstanceOf(BoxRuntimeError);
      expect(await probeStubModeld(runRoot)).toBe(true);
    } finally {
      await server.stop();
    }
    expect(await probeStubModeld(runRoot)).toBe(false);
  });
});
