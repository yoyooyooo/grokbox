import { expect, test } from "bun:test";
import { captureContextPolicy, contextBudget, summaryBudget, validateContextIntent, ContextPolicyError,
  defaultConfig, validateConfig, migrateConfigV2, configRevision } from "../src/config.ts";
import { measureContext, parseContextMaterial, ContextFailure } from "../src/contract.ts";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const policy = () => captureContextPolicy(undefined, "provider/model", A);

test("local 128K does not inherit the provider's 500K; output reserve is the actual maximum", () => {
  expect(contextBudget(policy(), 500000)).toMatchObject({ localWindowTokens: 128000, windowTokens: 128000,
    declaredWindowTokens: 500000, outputTokens: 16384, inputTokens: 111616, preferredTargetTokens: 66969, resumeThresholdTokens: 100454 });
  expect(contextBudget(policy(), 500000, 32000).inputTokens).toBe(96000);
  expect(contextBudget(policy()).declaredWindowTokens).toBeNull();
  expect(contextBudget(policy(), 64000).inputTokens).toBe(47616);
  expect(contextBudget(policy(), 500000, undefined, 64000).inputTokens).toBe(64000);
  expect(summaryBudget(policy(), 500000).outputTokens).toBe(8192);
});
test("context overrides are model then Bot, with dependency-local immutable revisions", () => {
  const p = captureContextPolicy({ windowTokens: 256000, models: { "provider/model": { windowTokens: 192000 } },
    agents: { [A]: { windowTokens: 128000 }, [B]: { windowTokens: 512000 } } }, "provider/model", A);
  expect(p.windowTokens).toBe(128000);
  expect(p.revision).toBe(policy().revision);
  const other = captureContextPolicy({ agents: { [B]: { windowTokens: 512000 } } }, "provider/model", A);
  expect(other.revision).toBe(p.revision);
  const next = captureContextPolicy({ compaction: { mode: "manual" } }, "provider/model", A);
  expect(next.revision).not.toBe(p.revision);
  expect(p.compaction.mode).toBe("auto");
});
test("invalid windows, output combinations, unknown/unsafe fields and accessor values reject", () => {
  for (const input of [{ windowTokens: 0 }, { windowTokens: 1.5 }, { windowTokens: 4096 },
    { windowTokens: 64000, compaction: { reserveTokens: 64000 } }, { compaction: { enabled: true } },
    { agents: { invalid: {} } }, { compaction: { limits: { maxSummaryRequests: 0 } } }, JSON.parse('{"models":{"__proto__":{}}}')]) {
    expect(() => validateContextIntent(input)).toThrow(ContextPolicyError);
  }
  let accessed = false;
  expect(() => validateContextIntent({ get windowTokens() { accessed = true; return 64000; } })).toThrow(ContextPolicyError);
  expect(accessed).toBe(false);
  expect(() => contextBudget(policy(), 8192)).toThrow(ContextPolicyError);
  expect(() => contextBudget(policy(), 128000, 128000)).toThrow(ContextPolicyError);
  const small = captureContextPolicy({ windowTokens: 8192, compaction: { reserveTokens: 1024, keepRecentTokens: 2000 } }, "model", A);
  expect(summaryBudget(small).inputTokens).toBe(7168);
});
test("schema v3 is explicit; v2 only enters through the migrator and retains other domains", () => {
  const original = { ...defaultConfig(), schemaVersion: 2, runtime: { desiredMode: "observe" as const }, desktop: { keepAgentIds: [A] } };
  expect(() => validateConfig(original)).toThrow("config migrate");
  const upgraded = migrateConfigV2(original);
  expect(upgraded.schemaVersion).toBe(3);
  expect(upgraded.runtime).toEqual(original.runtime);
  expect(upgraded.desktop).toEqual(original.desktop);
  expect(original.schemaVersion).toBe(2);
  expect(configRevision(upgraded)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => migrateConfigV2({ ...original, runtime: { context: { windowTokens: 64000 } } })).toThrow();
  const valid = validateConfig({ ...defaultConfig(), runtime: { context: { windowTokens: 128000 } } });
  expect(valid.runtime?.context?.windowTokens).toBe(128000);
  expect(() => validateConfig({ ...valid, schemaVersion: 4 })).toThrow();
});
test("first-request local measurement includes Unicode, tools and system without any provider usage", () => {
  const material = parseContextMaterial({ rootId: "root", rootRevision: "revision", messages: [
    { ref: "system", message: { role: "system", content: "system instructions" } },
    { ref: "user", message: { role: "user", content: "中文".repeat(50000) } },
  ], tools: [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }], options: {} });
  const m = measureContext(material);
  expect(m.method).toBe("estimate");
  expect(m.tokens).toBeGreaterThan(100000);
  expect(m.components.system).toBeGreaterThan(0);
  expect(m.components.tools).toBeGreaterThan(0);
  expect(m.uncertaintyTokens).toBeGreaterThan(0);
  expect(() => parseContextMaterial({ ...material, messages: [material.messages[0], material.messages[0]] })).toThrow(ContextFailure);
  let accessed = false;
  expect(() => parseContextMaterial({ get messages() { accessed = true; return []; } })).toThrow(ContextFailure);
  expect(accessed).toBe(false);
});
