import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendFailure } from "@grokbox/runtime-kernel/contract";
import { backendFailureFromUnknown } from "../src/internal/backends/provider-error.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { projectModeldStepOutcome } from "../src/internal/io/modeld-outcome.node.ts";
import { projectModelStepTerminal } from "../src/internal/io/journal.node.ts";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";

const sha = "a".repeat(64);
const binding = { generationId: sha, activationId: "op", pid: 1, start: 1, sourceSha: sha, identitySha: sha };
const compile = { profileId: "fixture", profileSha256: sha, sourceSha256: sha, transformedSha256: sha };
const base = { name: "model_step_terminal", schemaVersion: 3, at: "2026-09-09T00:00:00.000Z", hostGenerationId: sha,
  agentId: "fixture-agent", turnId: "turn", stepId: "step", serviceEpoch: "service", outcome: "error", phase: "provider", eventCount: 0 };

async function fixture(fetch: typeof globalThis.fetch, options: { echo?: boolean; brokenJournal?: boolean } = {}) {
  const durableRoot = await mkdtemp(join(tmpdir(), "out-d-")), runRoot = await mkdtemp(join(tmpdir(), "out-r-"));
  await mkdir(join(durableRoot, "state"));
  await writeFile(join(durableRoot, "state/desired.json"), JSON.stringify({ version: 1, mode: "route" }));
  await writeFile(join(durableRoot, "models.json"), JSON.stringify({ version: 1,
    models: options.echo ? {} : { "openai-responses/fixture": { provider: "openai-responses", model: "fixture", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:FIXTURE_KEY", capabilities: { tools: true, vision: false, images: false } } },
    assignments: { main: null, agents: { "fixture-agent": options.echo ? "stub/echo" : "openai-responses/fixture" } } }));
  if (options.brokenJournal) await mkdir(join(runRoot, "log/events.ndjson"), { recursive: true });
  await writeAttestation(runRoot, { mode: "route", coverage: "attested", modeld: true, diskSha: sha,
    pid: process.pid, start: 1, identity: { pid: process.pid, start: 1, uid: 1, ppid: 1, exe: "/owned/node", cmdline: ["node"], ancestry: [1] },
    at: new Date().toISOString(), profileId: "fixture", transformedSha: sha, operationId: "op", launchMode: "direct-launch", compile });
  const server = await startModeldProcess({ durableRoot, runRoot, fetch, env: { FIXTURE_KEY: "owned-fixture-key" } });
  const session = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile })({ agentId: "fixture-agent", sessionOptions: { invocationId: "turn" } });
  if (!isHostPromptSession(session)) throw Error("fixture session");
  return { session, server, runRoot };
}
async function outcomes(root: string) {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(join(root, "log/events.ndjson"), "utf8").catch(() => "");
    const rows = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const found = rows.filter(r => r.name === "model_step_terminal" && r.schemaVersion === 3);
    if (found.length) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error("missing outcome");
}

describe("modeld STEP outcome", () => {
  test("publication and reader allow only fixed classification, never raw error fields", () => {
    const input = { ...base, failureCode: "provider_error", prompt: "DO_NOT_PUBLISH", atExtra: "DO_NOT_PUBLISH",
      diagnostic: { phase: "provider", reason: "http", httpStatus: 400, providerCode: "invalid_request_error", providerParam: "instructions", message: "DO_NOT_PUBLISH", responseBody: "DO_NOT_PUBLISH", headers: { authorization: "DO_NOT_PUBLISH" } } };
    const output = projectModeldStepOutcome(input);
    expect(JSON.stringify(output)).not.toContain("DO_NOT_PUBLISH");
    expect(output).toMatchObject({ stepId: "step", diagnostic: { httpStatus: 400, providerParam: "instructions" } });
    expect(projectModelStepTerminal(input)).toEqual(output);
    for (const changed of [{ at: "DO_NOT_PUBLISH" }, { phase: "DO_NOT_PUBLISH" }, { stepId: "bad\nvalue" }, { eventCount: Infinity }]) {
      expect(projectModeldStepOutcome({ ...input, ...changed })).toBeNull();
    }
    expect(projectModeldStepOutcome({ ...base, failureCode: "DO_NOT_PUBLISH", diagnostic: { phase: "provider", reason: "http", providerParam: "DO_NOT_PUBLISH", httpStatus: "DO_NOT_PUBLISH" } })).not.toHaveProperty("failureCode");
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
      await expect(f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "step-http").response).rejects.toMatchObject({ name: "RetriableError" });
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
        }
      } finally { await f.server.stop(); }
    }
  });

  test("prepare refusal is distinct from provider execution", async () => {
    let requests = 0;
    const fetch = Object.assign(async () => { requests++; throw Error("unexpected HTTP"); }, { preconnect: async () => {} }) as typeof globalThis.fetch;
    const f = await fixture(fetch);
    try {
      await expect(f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }]).stream({}, "step-prepare", undefined, { seed: 1 }).response).rejects.toMatchObject({ name: "RetriableError" });
      const rows = await outcomes(f.runRoot);
      expect(rows[0]).toMatchObject({ stepId: "step-prepare", phase: "prepare", failureCode: "unsupported_options", eventCount: 0 });
      expect(rows[0].bindingId).toBeUndefined();
      expect(requests).toBe(0);
    } finally { await f.server.stop(); }
  });
});
