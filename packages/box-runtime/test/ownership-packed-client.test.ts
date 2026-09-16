import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { bindCompiledHost } from "../src/internal/host/host-binding.ts";
import { startModeldProcess, type StartedModeld } from "../src/internal/roots/modeld.runtime.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";

const project = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const preload = join(project, "dist/preload.cjs");
const childFile = fileURLToPath(new URL("./fixtures/packed-ownership-client.cjs", import.meta.url));
const AGENT = "88888888-8888-4888-8888-888888888888";
const SHA = "a".repeat(64);
const compile = { profileId: "fixture", profileSha256: SHA, sourceSha256: SHA, transformedSha256: SHA };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function startClient(root: string) {
  if (!existsSync(preload)) throw new Error("Build dist/preload.cjs before the packed ownership lane.");
  const child = fork(childFile, [], {
    execPath: "node", execArgv: ["--require", preload], cwd: root, silent: true,
    // No inherited Node preload, credentials, real product roots or live permission.
    env: { PATH: process.env.PATH, HOME: root, GROKBOX_PACKED_SESSION_FACTORY: "1",
      GROKBOX_ALLOW_LIVE_HOST: "0", GROKBOX_BOX_RUNTIME_ROOT: join(root, "durable"), GROKBOX_RUN_ROOT: join(root, "run") },
  });
  let next = 0;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const startupTimer = setTimeout(() => readyReject(new Error("packed client startup timeout")), 5000);
  const exit = new Promise<void>(resolveExit => child.once("exit", () => {
    clearTimeout(startupTimer);
    const error = new Error(`owned packed client exited: ${stderr}`);
    readyReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    resolveExit();
  }));
  child.on("error", error => { clearTimeout(startupTimer); readyReject(error); });
  child.on("message", message => {
    if (!object(message)) return;
    if (message.type === "ready") { clearTimeout(startupTimer); readyResolve(); return; }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.ok === true) entry.resolve(message.value);
    else entry.reject(message.error);
  });
  function call<T>(method: string, input?: unknown): Promise<T> {
    return new Promise((resolveCall, rejectCall) => {
      if (!child.connected) { rejectCall(new Error("packed client disconnected")); return; }
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`owned ${method} timeout`)); }, 10_000);
      pending.set(id, { resolve: value => resolveCall(value as T), reject: rejectCall, timer });
      child.send({ id, method, input }, error => {
        if (error) { clearTimeout(timer); pending.delete(id); rejectCall(error); }
      });
    });
  }
  return { child, ready, call, async stop() {
    if (child.connected) await call("stop").catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit;
  } };
}

async function waitOutcome(root: string) {
  for (let i = 0; i < 100; i++) {
    const lines = await readFile(join(root, "log/events.ndjson"), "utf8").catch(() => "");
    const rows: Array<Record<string, unknown>> = lines.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const found = rows.filter(row => row.name === "model_step_terminal" && row.schemaVersion === 3);
    if (found.length) return found;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error("missing production modeld outcome");
}

test("actual preload has no retired harness hook implementation", async () => {
  const packed = await readFile(preload, "utf8");
  expect(packed).not.toContain("bindHarnessStickHook");
  expect(packed).not.toContain("grokbox.box-runtime.harness-stick.v1");
});

for (const scenario of ["confirmed-box", "server-temporal", "legacy-evidence", "native-paused", "native-unbound", "native-state-unavailable"] as const) {
  test(`packaged Node Host/client and native-read facade -> production Unix gate: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gbox-packed-own-"));
    const client = startClient(root);
    let service: StartedModeld | undefined;
    let requests = 0;
    const durableRoot = join(root, "durable"), runRoot = join(root, "run");
    const fetchImpl = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("owned-model");
      expect(body.messages).toEqual([{ role: "system", content: "Owned system root." }, { role: "user", content: "Return the fixture answer." }]);
      const chunks = [
        { id: "owned-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "OWNED_PACKED_OK" }, finish_reason: null }] },
        { id: "owned-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      ];
      return new Response(chunks.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }, { preconnect: async () => undefined }) as typeof fetch;
    try {
      await client.ready;
      if (!client.child.pid) throw new Error("missing owned child PID");
      const pid = client.child.pid;
      const identity = { pid, start: 1, uid: 1, ppid: 1, exe: "/owned/node", cmdline: ["owned-node"], ancestry: [1] };
      const binding = bindCompiledHost(identity, "owned-op", compile);
      await mkdir(join(durableRoot, "state"), { recursive: true });
      await writeFile(join(durableRoot, "state/desired.json"), JSON.stringify({ version: 1, mode: "route" }));
      await writeFile(join(durableRoot, "models.json"), JSON.stringify({ version: 1,
        models: { "openai/owned-model": { provider: "openai", model: "owned-model", endpoint: "https://owned.invalid/v1",
          apiKeyRef: "env:OWNED_KEY", capabilities: { tools: true, vision: false, images: false }, contextWindowTokens: 200000 } },
        assignments: { main: null, agents: { [AGENT]: "openai/owned-model" } } }));
      await writeAttestation(runRoot, { mode: "route", coverage: "attested", modeld: true, diskSha: SHA,
        pid, start: 1, identity, at: new Date().toISOString(), profileId: "fixture", transformedSha: SHA,
        operationId: "owned-op", launchMode: "direct-launch", compile });
      await client.call("init", { durableRoot, runRoot, binding, compile, agentId: AGENT,
        turnId: `turn-${scenario}`, stepId: `step-${scenario}`, serverHarness: scenario === "server-temporal" ? "temporal" : "box", legacyEvidence: scenario === "legacy-evidence",
        executionState: scenario === "native-paused" ? "paused" : scenario === "native-unbound" ? "unbound"
          : scenario === "native-state-unavailable" ? "unavailable" : "allowed" });
      const ownershipRead: OwnershipReader = (ids, signal) => {
        if (signal.aborted) return Promise.reject(new Error("owned-cancelled"));
        return client.call("ownership", ids);
      };
      ownershipRead.local = (ids, signal) => {
        if (signal.aborted) return Promise.reject(new Error("owned-cancelled"));
        return client.call("ownership-local", ids);
      };
      service = await startModeldProcess({ durableRoot, runRoot, env: { OWNED_KEY: "owned-fixture-key" }, fetch: fetchImpl, ownershipRead });
      if (scenario === "confirmed-box") {
        const result = await client.call<{ finishReason: string; modelId: string; messages: unknown[] }>("run");
        expect(result).toMatchObject({ finishReason: "stop", modelId: "openai/owned-model" });
        expect(JSON.stringify(result.messages)).toContain("OWNED_PACKED_OK");
        expect(requests).toBe(1);
      } else {
        await expect(client.call("run")).rejects.toMatchObject({ managed: true, name: "RetriableError" });
        expect(requests).toBe(0);
      }
      const rows = await waitOutcome(runRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: AGENT, turnId: `turn-${scenario}`, stepId: `step-${scenario}`,
        outcome: scenario === "confirmed-box" ? "ok" : "error" });
      if (scenario !== "confirmed-box") expect(rows[0]).toMatchObject({ phase: "admission", eventCount: 0, failureCode: "not_admitted" });
      const counts = await client.call<{ nativeReads: number; officialEffects: number; executionReads: number }>("counts");
      expect(counts).toMatchObject({ nativeReads: scenario.startsWith("native-") ? 0 : 1, officialEffects: 0 });
      expect(counts.executionReads).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(rows)).not.toContain("PRIVATE_NATIVE_STATE");
    } finally {
      await service?.stop();
      await client.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}
