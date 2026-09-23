import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { NATIVE_HOST_BUNDLE as LIVE_HOST_BUNDLE } from "./native-host-source.ts";
import { nativeHostQualificationEnabled, QUALIFIED_NATIVE_HOST_SHA } from "./native-host-qualification.ts";

/** Explicit source-pinned function probes. Never execute the Host module or read
 * actual Bot files. Normalization, storage and network boundaries are owned
 * fakes; this proves the selected functions, NOT live HTTP or complete parsing. */
const nativeTest = test.skipIf(!nativeHostQualificationEnabled());
let selected: Map<string, string> | undefined, constants: Map<string, number>, schemaFields: string[];
function code(name: string): string {
  if (!selected) {
    const bytes = readFileSync(LIVE_HOST_BUNDLE, "utf8");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(QUALIFIED_NATIVE_HOST_SHA);
    const parsed = ts.createSourceFile("qualified-native.cjs", bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set(["automationConfigFromSpec", "automationConfigWithSpec", "automationRecordFromConfig", "stableAutomationId", "parseWebhookFireTriggerEvent"]);
    const found = new Map<string, string>(); constants = new Map(); schemaFields = [];
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
        expect(found.has(node.name.text)).toBe(false); found.set(node.name.text, node.getText(parsed));
      }
      if (ts.isMethodDeclaration(node) && ts.isClassExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent)
        && node.parent.parent.name.getText(parsed) === "SandWebhookCredentialService" && ["getCredential", "ensureKey", "webhookUrl"].includes(node.name.getText(parsed))) {
        const name = node.name.getText(parsed); expect(found.has(name)).toBe(false); found.set(name, node.getText(parsed));
      }
      if (ts.isVariableDeclaration(node) && ["AUTOMATION_UI_LIMIT", "FIRE_EVENT_TEXT_MAX_LENGTH"].includes(node.name.getText(parsed)) && node.initializer) {
        const source = node.initializer.getText(parsed);
        if (ts.isNumericLiteral(node.initializer)) constants.set(node.name.getText(parsed), Number(source.replaceAll("_", "")));
      }
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "automationSpec" && node.initializer && ts.isCallExpression(node.initializer)) {
        const shape = node.initializer.arguments[0];
        if (shape && ts.isObjectLiteralExpression(shape)) schemaFields = shape.properties.map(p => p.name?.getText(parsed) ?? "spread");
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed); expect(found.size).toBe(8); selected = found;
  }
  const result = selected.get(name); if (!result) throw Error("missing-qualified-routine-function"); return result;
}
function evaluate(source: string, globals: Record<string, unknown> = {}): any {
  return runInNewContext(source, globals, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
function specFunctions() {
  return evaluate(`${code("automationConfigFromSpec")}\n${code("automationConfigWithSpec")}\n({create:automationConfigFromSpec,update:automationConfigWithSpec})`, {
    clampAutomationName: (v: string) => v, normalizeAutomationPrompt: (v: string) => v, normalizeAutomationSpecTrigger: (v: unknown) => v,
  });
}
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spec = { name: "Owned fixture", prompt: "PRIVATE_ROUTINE_BODY", trigger: { type: "webhook" } };

nativeTest("native create is enabled by omission, while explicit disabled is preserved and update omission retains state", () => {
  const api = specFunctions();
  const implicit = api.create(spec, { createdAt: 100, provenance: "user" });
  const disabled = api.create({ ...spec, isEnabled: false }, { createdAt: 100, provenance: "user" });
  expect(implicit.isEnabled).toBe(true); expect(disabled.isEnabled).toBe(false);
  expect(api.update(disabled, spec, "user").isEnabled).toBe(false);
  expect(schemaFields).toEqual(["name", "prompt", "trigger", "isEnabled"]);
  expect(constants.get("AUTOMATION_UI_LIMIT")).toBe(100);
});

nativeTest("native record includes private prompt/path, while the public CLI view does not", () => {
  const config = specFunctions().create({ ...spec, isEnabled: false }, { createdAt: 100, provenance: "user" });
  const make = evaluate(`${code("automationRecordFromConfig")}\nautomationRecordFromConfig`, {
    triggerSchedule: () => undefined, describeTrigger: () => "Webhook",
  });
  const record = make({ id: "owned-routine", config, nextRunAt: null, runs: [], filePath: "/PRIVATE/NATIVE/config" });
  expect(record.prompt).toBe(spec.prompt); expect(record.filePath).toBe("/PRIVATE/NATIVE/config");
  const view = projectNativeRoutines(AGENT, JSON.parse(JSON.stringify([record])));
  expect(JSON.stringify(view)).not.toContain("PRIVATE"); expect(view.routines[0]!.enabled).toBe(false);
});

nativeTest("credential retrieval can enter a mint path and is not admitted as a read-only command", async () => {
  const stable = code("stableAutomationId"), method = code("getCredential"), ensure = code("ensureKey"), url = code("webhookUrl");
  const api = evaluate(`${stable}\n({${method},${ensure},${url}})`, { Buffer, URL,
    sha256Hex: (v: Uint8Array) => createHash("sha256").update(v).digest("hex") });
  const keys: Record<string, string> = {}, requests: string[] = [];
  api.deps = { backend: { backendUrl: "https://owned.invalid" } }; api.inFlightMints = new Map();
  api.loadKeys = async () => keys;
  api.mintAndPersist = async (id: string) => { requests.push(id); keys[id] = "SYNTHETIC_KEY"; return keys[id]; };
  const first = await api.getCredential({ agentId: AGENT, localId: "owned" });
  const again = await api.getCredential({ agentId: AGENT, localId: "owned" });
  expect(requests).toHaveLength(1); expect(first).toEqual(again); expect(first.url).toContain("/automations/webhook/");
  await api.getCredential({ agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", localId: "owned" });
  expect(requests).toHaveLength(2); expect(requests[0]).not.toBe(requests[1]);
});

nativeTest("native webhook fire parsing requires a body digest and bounds body/context; this is not HTTP admission proof", () => {
  const parser = code("parseWebhookFireTriggerEvent"), maximum = constants.get("FIRE_EVENT_TEXT_MAX_LENGTH");
  expect(maximum).toBeGreaterThan(0);
  const parse = evaluate(`${parser}\nparseWebhookFireTriggerEvent`, { FIRE_EVENT_TEXT_MAX_LENGTH: maximum,
    isUnknownRecord2: (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) });
  expect(parse({ body: "test" }, 100)).toBeNull();
  const input = { bodyDigest: `sha256:${"a".repeat(64)}`, body: '{"incident":"synthetic"}', context: "owned fixture", headers: { "x-fixture": "ok" } };
  expect(parse(input, 100)).toMatchObject({ source: "webhook", body: input.body, context: input.context, timestampMs: 100 });
  expect(parse({ ...input, body: "x".repeat(maximum! + 1) }, 100)).toBeNull();
  expect(parse({ ...input, context: "x".repeat(maximum! + 1) }, 100)).toBeNull();
});
