import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BoxRuntimeError } from "../src/errors.ts";
import { buildModelEnvelope } from "../src/envelope.ts";
import { createOpenAiModeldDriver, openAiAccepts } from "../src/modeld-openai.ts";
import {
  assertRouteAssignment,
  parseModelsFile,
  routeModelAdmitted,
  STUB_ECHO_MODEL,
  type ModelRecord,
} from "../src/models.ts";

const FIXTURE = join(import.meta.dir, "fixtures/sub2api-models.json");
const CCS_BASE = "https://provider.example.invalid/";

describe("T8 CCS sub2api recipe (offline, no spend)", () => {
  test("fixture admits luna and grok over CCS https; other schemes fail-closed", async () => {
    const file = parseModelsFile(JSON.parse(await readFile(FIXTURE, "utf8")));
    expect(file.assignments.main).toBe("openai-responses/gpt-5.6-luna");
    const luna = file.models["openai-responses/gpt-5.6-luna"]!;
    const grok = file.models["openai-responses/grok-4.6"]!;
    expect(luna.endpoint).toBe(CCS_BASE);
    expect(luna.apiKeyRef).toBe("env:GROKBOX_SUB2API_KEY");
    expect(grok.provider).toBe("openai-responses");
    expect(openAiAccepts(luna)).toBe(true);
    expect(openAiAccepts(grok)).toBe(true);
    expect(routeModelAdmitted(luna)).toBe(true);
    assertRouteAssignment(file);
    expect(JSON.stringify(file)).not.toMatch(/sk-|Bearer |api[_-]?key\s*[:=]/i);

    expect(openAiAccepts(STUB_ECHO_MODEL)).toBe(false);
    expect(openAiAccepts({ ...luna, endpoint: "wss://example.test/" })).toBe(false);
    expect(openAiAccepts({ ...luna, endpoint: "stub:echo" })).toBe(false);
    expect(openAiAccepts({ ...luna, apiKeyRef: "" })).toBe(false);
    expect(() => assertRouteAssignment({
      version: 1,
      models: { "acme/fast": { ...luna, id: "acme/fast", provider: "acme", model: "fast" } },
      assignments: { main: "acme/fast", agents: {} },
    })).toThrow(BoxRuntimeError);
  });

  test("Responses driver joins CCS https baseURL to /responses without requiring /v1", async () => {
    const urls: string[] = [];
    const luna: ModelRecord = {
      id: "openai-responses/gpt-5.6-luna",
      provider: "openai-responses",
      model: "gpt-5.6-luna",
      endpoint: CCS_BASE,
      apiKeyRef: "env:GROKBOX_SUB2API_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => "test-key",
      fetch: (async (input: unknown) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return new Response("nope", { status: 401 });
      }) as unknown as typeof fetch,
    });
    await Promise.resolve(driver.complete({
      pin: {
        model: luna,
        assignment: "main",
        fingerprint: "a".repeat(64),
        credentialFingerprint: "b".repeat(64),
      },
      envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "t8-luna",
      agentId: "agent-tom",
      signal: new AbortController().signal,
    })).catch(() => undefined);
    expect(urls.some((url) => url.startsWith("https://provider.example.invalid/responses"))).toBe(true);
    expect(urls.some((url) => url.includes("/v1/"))).toBe(false);
    expect(JSON.stringify(urls)).not.toMatch(/test-key|GROKBOX_SUB2API_KEY|sk-/);
  });
});
