import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendFailure } from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown } from "../src/internal/backends/provider-error.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { projectModeldStepOutcome, snapshotWireMeasures } from "../src/internal/io/modeld-outcome.node.ts";
import { projectModelStepTerminal } from "../src/internal/io/journal.node.ts";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { bindCompiledHost } from "../src/internal/host/host-binding.ts";
import { ownedOwnershipReader, ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";

const sha = "a".repeat(64);
const compile = { profileId: "fixture", profileSha256: sha, sourceSha256: sha, transformedSha256: sha };
const base = { name: "model_step_terminal", schemaVersion: 3, at: "2026-09-09T00:00:00.000Z", hostGenerationId: sha,
  agentId: "fixture-agent", turnId: "turn", stepId: "step", serviceEpoch: "service", outcome: "error", phase: "provider", eventCount: 0 };

async function fixture(fetch: typeof globalThis.fetch, options: { echo?: boolean; brokenJournal?: boolean; ownershipRead?: OwnershipReader | null } = {}) {
  const durableRoot = await mkdtemp(join(tmpdir(), "out-d-")), runRoot = await mkdtemp(join(tmpdir(), "out-r-"));
  await mkdir(join(durableRoot, "state"), { mode: 0o700 });
  await writeFile(join(durableRoot, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
  await writeFile(join(durableRoot, "models.json"), JSON.stringify({ version: 1,
    models: options.echo ? {} : { "openai-responses/fixture": { provider: "openai-responses", model: "fixture", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:FIXTURE_KEY", capabilities: { tools: true, vision: false, images: false }, contextWindowTokens: 200000 } },
    assignments: { main: null, agents: { "fixture-agent": options.echo ? "stub/echo" : "openai-responses/fixture" } } }));
  if (options.brokenJournal) await mkdir(join(runRoot, "log/events.ndjson"), { recursive: true });
  const identity = { pid: process.pid, start: 1, uid: 1, ppid: 1, exe: "/owned/node", cmdline: ["node"], ancestry: [1] };
  const binding = bindCompiledHost(identity, "op", compile);
  await writeAttestation(runRoot, { mode: "route", coverage: "attested", modeld: true, diskSha: sha,
    pid: process.pid, start: 1, identity,
    at: new Date().toISOString(), profileId: "fixture", transformedSha: sha, operationId: "op", launchMode: "direct-launch", compile });
  const server = await startModeldProcess({ durableRoot, runRoot, fetch, env: { FIXTURE_KEY: "owned-fixture-key" }, ownershipRead: options.ownershipRead === null ? undefined : options.ownershipRead ?? ownedOwnershipReader(process.pid) });
  const session = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile })({ agentId: "fixture-agent", sessionOptions: { invocationId: "turn" } });
  if (!isHostPromptSession(session)) throw Error("fixture session");
  return { session, server, runRoot };
}
async function outcomes(root: string) {
  let last: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 50; i++) {
    const text = await readFile(join(root, "log/events.ndjson"), "utf8").catch(() => "");
    const rows = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
    last = rows;
    const found = rows.filter(r => r.name === "model_step_terminal" && r.schemaVersion === 3);
    if (found.length) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error(`missing outcome: ${JSON.stringify(last.map(({ name, stage, reason, errorCode }) => ({ name, stage, reason, errorCode })))}`);
}

describe("modeld STEP outcome", () => {
  for (const scenario of ["missing-reader", "server-temporal", "old-bridge", "wrong-gateway"] as const) {
    test(`production root ownership ${scenario} refuses a real Host/Unix STEP before provider`, async () => {
      let requests = 0;
      const fetchImpl = Object.assign(async () => { requests++; throw Error("provider-must-not-run"); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
      const ownershipRead = scenario === "missing-reader" ? null : async (ids: string[]) => {
        const snapshot: Record<string, unknown> = ownedOwnershipSnapshot(ids, { serverHarness: scenario === "server-temporal" ? "temporal" : "box" });
        if (scenario === "old-bridge") { snapshot.schemaVersion = 1; delete snapshot.scope; }
        return { snapshot, gateway: { pid: scenario === "wrong-gateway" ? process.pid + 1 : process.pid, startedAt: 1 } };
      };
      const f = await fixture(fetchImpl, { ownershipRead });
      try {
        const handle = f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "owned-denied-step");
        let rejected: unknown;
        try { await handle.response; } catch (error) { rejected = error; }
        expect(rejected).toMatchObject({ name: "RetriableError" });
        expect(requests).toBe(0);
        const rows = await outcomes(f.runRoot);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ phase: "admission", outcome: "error", failureCode: "not_admitted", eventCount: 0 });
      } finally { await f.server.stop(); }
    });
  }

  test("a cold ownership read may exceed the old local 500ms admission window without losing the STEP", async () => {
    let reads = 0, requests = 0;
    const read = ownedOwnershipReader(process.pid);
    const f = await fixture(Object.assign(async () => { requests++; throw Error("echo_has_no_provider_request"); },
      { preconnect: async () => undefined }) as typeof globalThis.fetch, {
      echo: true,
      ownershipRead: async (ids, signal) => {
        if (++reads === 1) await new Promise<void>(resolve => setTimeout(resolve, 700));
        return read(ids, signal);
      },
    });
    try {
      const handle = f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "cold-ownership-step");
      const response = await handle.response;
      expect(response.finishReason).toBe("stop");
      expect(requests).toBe(0);
      expect(reads).toBeGreaterThan(0);
      expect(await outcomes(f.runRoot)).toMatchObject([{ stepId: "cold-ownership-step", outcome: "ok" }]);
    } finally { await f.server.stop(); }
  });

  test("publication and reader allow only fixed classification, never raw error fields", () => {
    const input = { ...base, failureCode: "provider_error", prompt: "DO_NOT_PUBLISH", atExtra: "DO_NOT_PUBLISH",
      diagnostic: { phase: "provider", reason: "http", httpStatus: 400, providerCode: "invalid_request_error", providerParam: "instructions", message: "DO_NOT_PUBLISH", responseBody: "DO_NOT_PUBLISH", headers: { authorization: "DO_NOT_PUBLISH" } } };
    const output = projectModeldStepOutcome(input);
    expect(JSON.stringify(output)).not.toContain("DO_NOT_PUBLISH");
    expect(output).toMatchObject({ stepId: "step", diagnostic: { httpStatus: 400, providerParam: "instructions" } });
    expect(projectModeldStepOutcome({ ...base, snapshotBytes: 128, messageChars: 40, messageCount: 2, prompt: "DO_NOT_PUBLISH" })).toMatchObject({
      snapshotBytes: 128, messageChars: 40, messageCount: 2,
    });
    expect(JSON.stringify(projectModeldStepOutcome({ ...base, snapshotBytes: 128, prompt: "DO_NOT_PUBLISH" }))).not.toContain("DO_NOT_PUBLISH");
    expect(projectModelStepTerminal(input)).toEqual(output);
    for (const changed of [{ at: "DO_NOT_PUBLISH" }, { phase: "DO_NOT_PUBLISH" }, { stepId: "bad\nvalue" }, { eventCount: Infinity }]) {
      expect(projectModeldStepOutcome({ ...input, ...changed })).toBeNull();
    }
    expect(projectModeldStepOutcome({ ...base, failureCode: "DO_NOT_PUBLISH", diagnostic: { phase: "provider", reason: "http", providerParam: "DO_NOT_PUBLISH", httpStatus: "DO_NOT_PUBLISH" } })).not.toHaveProperty("failureCode");
  });

  test("tool continuation measures expose counts and policy, never names or result bodies", () => {
    const snapshot = {
      version: 1 as const, profileId: "owned", abiIdentity: "owned", snapshotDigest: "a".repeat(64),
      systemMessages: [{ role: "system" as const, content: "system" }],
      messages: [{ role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "one", toolName: "DO_NOT_PUBLISH", args: {} }] },
        { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "one", result: "DO_NOT_PUBLISH" }] }],
      tools: [{ name: "DO_NOT_PUBLISH", inputSchema: { type: "object" } }],
      options: { toolChoice: { type: "tool" as const, toolName: "DO_NOT_PUBLISH" } },
    };
    const measures = snapshotWireMeasures(snapshot);
    expect(measures).toMatchObject({ requestToolCount: 1, historyToolCallCount: 1, historyToolResultCount: 1, toolChoicePolicy: "named" });
    const safe = projectModeldStepOutcome({ ...base, ...measures });
    expect(safe).toMatchObject({ requestToolCount: 1, historyToolCallCount: 1, historyToolResultCount: 1, toolChoicePolicy: "named" });
    expect(JSON.stringify(safe)).not.toContain("DO_NOT_PUBLISH");
    for (const bad of [-1, Infinity, "DO_NOT_PUBLISH", 65537]) {
      const projected = projectModeldStepOutcome({ ...base, requestToolCount: bad, historyToolResultCount: bad, toolChoicePolicy: bad });
      expect(projected).not.toHaveProperty("requestToolCount");
      expect(projected).not.toHaveProperty("historyToolResultCount");
      expect(projected).not.toHaveProperty("toolChoicePolicy");
    }
  });

  test("classifications stay request-local and preserve failure identity", () => {
    const a = backendFailureFromUnknown(Object.assign(new Error("sensitive message"), { statusCode: 401 }));
    const b = backendFailureFromUnknown(Object.assign(new Error("other sensitive message"), { statusCode: 400,
      responseBody: JSON.stringify({ error: { code: "invalid_request_error", param: "input", message: "DO_NOT_PUBLISH" } }) }));
    expect(backendFailureObservation(a)).toEqual({ phase: "provider", reason: "auth", httpStatus: 401 });
    expect(backendFailureObservation(b)).toMatchObject({ phase: "provider", reason: "http", httpStatus: 400, providerParam: "input" });
    expect(backendFailureFromUnknown(b)).toBe(b);
    expect(backendFailureObservation(backendFailureFromUnknown(new BackendFailure("stream_invalid")))).toEqual({ phase: "normalize", reason: "stream_shape" });
  });

  test("real SDK + production Unix root records same-STEP HTTP classification with zero raw body", async () => {
    let requests = 0;
    const fetch = Object.assign(async () => { requests++; return new Response(JSON.stringify({ error: {
      message: "DO_NOT_PUBLISH", type: "invalid_request_error", param: "instructions", code: "missing_required_parameter",
    } }), { status: 400, headers: { "content-type": "application/json" } }); }, { preconnect: async () => {} }) as typeof globalThis.fetch;
    const f = await fixture(fetch);
    const logging = spyOn(console, "error").mockImplementation(() => {});
    try {
      let rejected: unknown;
      try { await f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "step-http").response; }
      catch (error) { rejected = error; }
      expect(rejected).toMatchObject({ name: "RetriableError" });
      expect(requests).toBe(1);
      const rows = await outcomes(f.runRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: "fixture-agent", turnId: "turn", stepId: "step-http", outcome: "error", phase: "provider", failureCode: "provider_error", eventCount: 0,
        diagnostic: { phase: "provider", reason: "http", httpStatus: 400, providerCode: "missing_required_parameter", providerParam: "instructions" } });
      expect(typeof rows[0].bindingId).toBe("string");
      expect(JSON.stringify(rows)).not.toContain("DO_NOT_PUBLISH");
      expect(requests).toBe(1);
      expect(logging).not.toHaveBeenCalled();
    } finally { logging.mockRestore(); await f.server.stop(); }
  });

  test("success is observed separately from Host delivery; a broken journal cannot fail inference", async () => {
    const fetch = Object.assign(async () => { throw Error("echo cannot send HTTP"); }, { preconnect: async () => {} }) as typeof globalThis.fetch;
    for (const brokenJournal of [false, true]) {
      const f = await fixture(fetch, { echo: true, brokenJournal });
      try {
        const response = await f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "step-ok").response;
        expect(response.finishReason).toBe("stop");
        if (!brokenJournal) {
          const rows = await outcomes(f.runRoot);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ stepId: "step-ok", outcome: "ok", phase: "complete" });
          expect(rows[0].eventCount).toBeGreaterThan(0);
          expect(rows[0].snapshotBytes).toBeGreaterThan(0);
          expect(rows[0].messageChars).toBeGreaterThan(0);
          expect(rows[0].messageCount).toBeGreaterThan(0);
        }
      } finally { await f.server.stop(); }
    }
  });

  test("prepare refusal is distinct from provider execution", async () => {
    let requests = 0;
    const fetch = Object.assign(async () => { requests++; throw Error("unexpected HTTP"); }, { preconnect: async () => {} }) as typeof globalThis.fetch;
    const f = await fixture(fetch);
    try {
      let rejected: unknown;
      try { await f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "step-prepare", undefined, { seed: 1 }).response; }
      catch (error) { rejected = error; }
      expect(rejected).toMatchObject({ name: "RetriableError", code: "unsupported_options" });
      const rows = await outcomes(f.runRoot);
      expect(rows[0]).toMatchObject({ stepId: "step-prepare", phase: "prepare", failureCode: "unsupported_options", eventCount: 0 });
      expect(rows[0].bindingId).toBeUndefined();
      expect(requests).toBe(0);
    } finally { await f.server.stop(); }
  });
});
