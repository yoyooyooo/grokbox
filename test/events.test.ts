import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonProcessConfig } from "../src/daemon/config.ts";
import { writeProfileFile } from "../src/config/profile.ts";
import { createProductionDeps } from "../src/deps.ts";
import { EventJournal } from "../src/daemon/events.ts";
import { GovernedFilesystem } from "../src/daemon/filesystem.ts";
import { JobManager } from "../src/daemon/jobs.ts";
import { ProcessAuthority } from "../src/daemon/process.ts";
import { GatewayClient, parseSse } from "../src/gateway.ts";
import { redactEventPayload } from "../src/redaction.ts";
import { captureCli, parseJson } from "./helpers.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const testLinux = process.platform === "linux" ? test : test.skip;

async function nodeExecutable(): Promise<string> {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is unavailable in PATH.");
  return await realpath(node);
}

describe("unified events and recovery", () => {
  test("journal resumes exact cursors, filters sources, and gates Memory content", async () => {
    let now = 100;
    const journal = new EventJournal(generation, () => now++);
    journal.publish({ source: "daemon", kind: "started", payload: { daemonPid: 1 } });
    journal.publish({ source: "job", kind: "state", operationId: "job-1", payload: { jobId: "job-1", state: "running" } });
    journal.publish({
      source: "gateway", kind: "event", channel: "memory", gateway: { pid: 2, startedAt: 3 },
      payload: { agentId: "a", count: 1 }, privatePayload: { agentId: "a", memories: [{ id: "m", content: "allowed" }] },
    });

    const jobPage = await journal.read({
      cursor: `${generation}:0`, sources: ["job"], channels: ["agents"],
      includeMemoryContent: false, limit: 10, waitMs: 0,
    });
    expect(jobPage.events).toHaveLength(1);
    expect(jobPage.events[0]).toMatchObject({ source: "job", operationId: "job-1", payload: { state: "running" } });
    expect(jobPage.cursor).toBe(`${generation}:3`);

    const hidden = await journal.read({
      cursor: `${generation}:2`, sources: ["gateway"], channels: ["memory"],
      includeMemoryContent: false, limit: 10, waitMs: 0,
    });
    expect(hidden.events[0]?.payload).toEqual({ agentId: "a", count: 1 });
    const shown = await journal.read({
      cursor: `${generation}:2`, sources: ["gateway"], channels: ["memory"],
      includeMemoryContent: true, limit: 10, waitMs: 0,
    });
    expect(JSON.stringify(shown.events[0]?.payload)).toContain("allowed");
  });

  test("generation changes and journal eviction emit explicit gaps", async () => {
    const journal = new EventJournal(generation, Date.now);
    journal.publish({ source: "daemon", kind: "started", payload: {} });
    const changed = await journal.read({
      cursor: "22222222-2222-4222-8222-222222222222:9", sources: ["daemon"], channels: ["agents"],
      includeMemoryContent: false, limit: 10, waitMs: 0,
    });
    expect(changed.gap).toMatchObject({ reason: "daemon_generation_changed", oldestAvailableSequence: 1 });
    expect(changed.events).toHaveLength(1);

    for (let index = 0; index < 2050; index += 1) {
      journal.publish({ source: "job", kind: "state", payload: { index } });
    }
    const evicted = await journal.read({
      cursor: `${generation}:1`, sources: ["job"], channels: ["agents"],
      includeMemoryContent: false, limit: 2, waitMs: 0,
    });
    expect(evicted.gap?.reason).toBe("history_evicted");
    expect(evicted.events).toHaveLength(2);
  });

  test("long-poll subscribers have independent cursors", async () => {
    const journal = new EventJournal(generation, Date.now);
    const left = journal.read({
      cursor: `${generation}:0`, sources: ["job"], channels: ["agents"],
      includeMemoryContent: false, limit: 10, waitMs: 1000,
    });
    const right = journal.read({
      cursor: `${generation}:0`, sources: ["job"], channels: ["agents"],
      includeMemoryContent: false, limit: 10, waitMs: 1000,
    });
    journal.publish({ source: "job", kind: "state", payload: { jobId: "j", state: "queued" } });
    expect((await left).events).toEqual((await right).events);
  });

  testLinux("Job lifecycle transitions publish safe operation events", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-event-jobs-config-"));
    const root = await mkdtemp(join(tmpdir(), "grokbox-event-jobs-root-"));
    const executable = await nodeExecutable();
    const policy: DaemonProcessConfig = {
      cwdRoots: ["workspace"], defaultCwdRoot: "workspace",
      executables: [{ name: "node", path: executable }], environment: [],
      maxConcurrent: 1, maxQueued: 1, maxRuntimeMs: 10_000, maxOutputBytes: 1024,
    };
    const journal = new EventJournal(generation, Date.now);
    const filesystem = await GovernedFilesystem.create([{ name: "workspace", path: root, operations: ["exec"] }], Date.now);
    const manager = await JobManager.create(
      configDir,
      await ProcessAuthority.create(policy),
      filesystem,
      Date.now,
      generation,
      (event) => journal.publish({
        source: "job", kind: "state", operationId: event.cancelOperationId ?? event.jobId,
        payload: event,
      }),
    );
    const jobId = randomUUID();
    try {
      await manager.submit({
        jobId, cwd: "workspace:/", argv: ["node", "-e", "process.exit(0)"], environment: {},
        runTimeoutMs: 1000, output: "discard", shell: false,
      });
      for (let count = 0; count < 100 && ["queued", "running"].includes(manager.show(jobId).state); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let page = await journal.read({
        cursor: `${generation}:0`, sources: ["job"], channels: ["agents"],
        includeMemoryContent: false, limit: 10, waitMs: 0,
      });
      for (let count = 0; count < 100 && page.events.length < 3; count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        page = await journal.read({
          cursor: `${generation}:0`, sources: ["job"], channels: ["agents"],
          includeMemoryContent: false, limit: 10, waitMs: 0,
        });
      }
      expect(page.events.map((event) => (event.payload as { state: string }).state)).toEqual(["queued", "running", "succeeded"]);
      const text = JSON.stringify(page.events);
      expect(text).not.toContain("workspace:/");
      expect(text).not.toContain("process.exit");
    } finally {
      await manager.close();
      await filesystem.close();
    }
  });

  test("event projectors deny prompt, auth, environment, and transcript content by default", () => {
    const transcript = redactEventPayload("transcript", {
      agentId: "a", entryId: "e", role: "user", timestampMs: 1,
      content: "prompt secret", prompt: "prompt secret", token: "credential", environment: { SECRET: "value" },
    }, false);
    expect(transcript).toEqual({ agentId: "a", entryId: "e", role: "user", timestampMs: 1 });

    const roster = redactEventPayload("agents", {
      agents: [{ id: "a", name: "n", title: "t", path: "/secret", avatarDataUrl: "secret", lastMessagePreview: "prompt" }],
      credential: "secret",
    }, false);
    const text = JSON.stringify(roster);
    expect(text).not.toContain("/secret");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("credential");
    expect(redactEventPayload("unknown", { token: "secret" }, true)).toEqual({});
  });

  test("daemon event pages reject mismatched cursors and non-monotonic sequences before output", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-event-page-config-"));
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "https://daemon.invalid",
      daemon_token_ref: "env:DAEMON_TOKEN",
    });
    const handshake = {
      protocolMajor: 1, daemonVersion: "0.0.1", daemonPid: 1, startedAt: 1,
      daemonGeneration: generation, capabilities: ["grok.events.read"], filesystemRoots: [],
      gateway: { pid: 2, startedAt: 2 },
    };
    const pages = [
      {
        daemonGeneration: generation,
        cursor: "22222222-2222-4222-8222-222222222222:1",
        events: [],
      },
      {
        daemonGeneration: generation,
        cursor: `${generation}:2`,
        events: [
          { source: "daemon", kind: "state", sequence: 2, observedAtMs: 2, payload: {} },
          { source: "daemon", kind: "state", sequence: 1, observedAtMs: 1, payload: {} },
        ],
      },
    ];
    for (const page of pages) {
      const result = await captureCli(["--profile", "remote", "events", "--once"], {
        configDir,
        skillsDir: join(import.meta.dir, "..", "skills"),
        env: { DAEMON_TOKEN: "credential" },
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as { method: string };
          return Response.json({ ok: true, result: request.method === "handshake" ? handshake : page });
        }) as typeof fetch,
      });
      expect(result.code).toBe(26);
      expect(result.stdout).toBe("");
      expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("daemon_unreachable");
    }

    const regressedPage = {
      daemonGeneration: generation,
      cursor: `${generation}:200`,
      events: [{ source: "daemon", kind: "state", sequence: 1, observedAtMs: 1, payload: {} }],
    };
    const regressed = await captureCli([
      "--profile", "remote", "events", "--once", "--cursor", `${generation}:100`,
    ], {
      configDir,
      skillsDir: join(import.meta.dir, "..", "skills"),
      env: { DAEMON_TOKEN: "credential" },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        return Response.json({ ok: true, result: request.method === "handshake" ? handshake : regressedPage });
      }) as typeof fetch,
    });
    expect(regressed.code).toBe(26);
    expect(regressed.stdout).toBe("");
  });

  test("Gateway 401 retries after token-only credential rotation", async () => {
    let discoveryReads = 0;
    let requests = 0;
    const authorizations: string[] = [];
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      readFile: async () => {
        discoveryReads += 1;
        return JSON.stringify({
          scheme: "http", host: "127.0.0.1", port: 31337,
          pid: 1,
          startedAt: 10,
          token: discoveryReads === 1 ? "old-token" : "new-token",
        });
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requests += 1;
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json(requests === 1 ? { failureCode: "unauthorized" } : { accepted: true }, { status: requests === 1 ? 401 : 200 });
      }) as typeof fetch,
    };
    const result = await new GatewayClient(deps).sendPrompt({
      agentId: "a", prompt: "content", clientNonce: randomUUID(),
    }, 1000);
    expect(result.result).toEqual({ accepted: true });
    expect(authorizations).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  test("Gateway 401 does not reuse a rejected credential after generation-only rotation", async () => {
    let discoveryReads = 0;
    let requests = 0;
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      readFile: async () => {
        discoveryReads += 1;
        return JSON.stringify({
          scheme: "http", host: "127.0.0.1", port: 31337,
          pid: discoveryReads, startedAt: discoveryReads * 10, token: "rejected-token",
        });
      },
      fetch: (async () => {
        requests += 1;
        return Response.json({ failureCode: "unauthorized" }, { status: 401 });
      }) as unknown as typeof fetch,
    };
    await expect(new GatewayClient(deps).sendPrompt({
      agentId: "a", prompt: "content", clientNonce: randomUUID(),
    }, 1000)).rejects.toMatchObject({ code: "gateway_unauthorized" });
    expect(discoveryReads).toBe(2);
    expect(requests).toBe(1);
  });

  test("SSE parsing preserves split delimiters and UTF-8 and reports partial EOF", async () => {
    const encoded = Buffer.from(`data: ${JSON.stringify({ channel: "agents", payload: { label: "check-\u2713" } })}\n\n`);
    const marker = Buffer.from("\u2713");
    const markerOffset = encoded.indexOf(marker);
    const chunks = [
      encoded.subarray(0, markerOffset + 1),
      encoded.subarray(markerOffset + 1, encoded.length - 1),
      encoded.subarray(encoded.length - 1),
    ];
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const values: unknown[] = [];
    const gaps: string[] = [];
    for await (const value of parseSse(split, { onGap: (reason) => gaps.push(reason) })) values.push(value);
    expect(values).toEqual([{ channel: "agents", payload: { label: "check-\u2713" } }]);
    expect(gaps).toEqual([]);

    const partial = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('data: {"channel":"agents"'));
        controller.close();
      },
    });
    for await (const value of parseSse(partial, { onGap: (reason) => gaps.push(reason) })) values.push(value);
    expect(values).toHaveLength(1);
    expect(gaps).toEqual(["malformed_frame"]);
  });

  test("SSE parsing reports malformed and oversized frames without yielding them", async () => {
    const reasons: string[] = [];
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("data: {bad json}\n\n"));
        controller.close();
      },
    });
    const values: unknown[] = [];
    for await (const value of parseSse(malformed, { onGap: (reason) => reasons.push(reason) })) values.push(value);
    expect(values).toEqual([]);
    expect(reasons).toEqual(["malformed_frame"]);

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${"x".repeat(300 * 1024)}\n\n`));
        controller.close();
      },
    });
    for await (const value of parseSse(oversized, { onGap: (reason) => reasons.push(reason) })) values.push(value);
    expect(reasons).toContain("frame_too_large");
  });
});
