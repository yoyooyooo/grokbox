import { describe, expect, test } from "bun:test";
import { applyConfigChange, ConfigError, configPathTokens, configRevision, configurationRevisions, defaultConfig, effectiveOps, getConfigValue, parseConfigJson, portableConfig, validateConfig } from "../src/config.ts";

const id = "00000000-0000-4000-8000-000000000123";
const change = (extra: Record<string, unknown>) => ({ operationId: "config-test", scope: "box" as const, ...extra });

describe("unified config grammar and ownership", () => {
  test("strict JSON rejects duplicate, escaped duplicate, unsafe members and deep input", () => {
    for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"__proto__":{}}', '{"x":{"constructor":1}}', '[1,]', '{"a":1,}', 'true false', '1e999', '01', '"unterminated']) {
      expect(() => parseConfigJson(input), input).toThrow(ConfigError);
    }
    expect(parseConfigJson(' {"text":"a\\\"b","list":[-0.5,true,null]} ')).toEqual({ text: 'a"b', list: [-0.5, true, null] });
    expect(() => parseConfigJson("[".repeat(45) + "0" + "]".repeat(45))).toThrow();
  });
  test("the only normal document is v2; models and machine approvals are not fields", () => {
    expect(validateConfig(defaultConfig())).toEqual(defaultConfig());
    expect(() => validateConfig({ version: 1 })).toThrow("migrate");
    for (const key of ["models", "binding", "bindings", "maintenanceGrants", "current_profile", "overrides"]) {
      expect(() => validateConfig({ ...defaultConfig(), [key]: {} })).toThrow();
    }
    expect(() => validateConfig({ ...defaultConfig(), desktop: { floorAgentIds: [id] } })).toThrow();
    expect(() => validateConfig({ ...defaultConfig(), daemon: { network: { host: "127.0.0.1", port: 8080, tokenSha256: "x" } } })).toThrow();
  });
  test("dotted and JSON Pointer share safe own-property semantics, array indices never traverse", () => {
    expect(configPathTokens("/client/profiles/work.v2/transport")).toEqual(["client", "profiles", "work.v2", "transport"]);
    expect(configPathTokens("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    for (const path of ["a..b", "/bad~2escape", "__proto__.x", "/constructor", "a.prototype"]) expect(() => configPathTokens(path)).toThrow();
    expect(getConfigValue({ values: [1] }, ["values", "0"])).toBeUndefined();
    expect(getConfigValue({}, ["toString"])).toBeUndefined();
  });
  test("parent replacement cannot hide floor, unknown routing or a grant", () => {
    for (const value of [{ floorAgentIds: [id] }, { idleReclaim: { enabled: true }, stopWindowPath: "/tmp/exec" }]) {
      expect(() => applyConfigChange(defaultConfig(), { ...change({}), kind: "set", path: "desktop", value, confirm: true })).toThrow();
    }
    expect(() => validateConfig({ ...defaultConfig(), ops: { targets: { default: {} }, routing: { defaultTarget: "missing" } } })).toThrow();
  });
  test("arrays require revision and explicit replacement, keep add is a latest-state domain mutation", () => {
    const doc = defaultConfig();
    expect(() => applyConfigChange(doc, { ...change({}), kind: "set", path: "desktop.keepAgentIds", value: [id] })).toThrow();
    const added = applyConfigChange(doc, { ...change({}), kind: "keep", action: "add", agentId: id }).document;
    expect(added.desktop?.keepAgentIds).toEqual([id]);
    expect(applyConfigChange(added, { ...change({}), kind: "keep", action: "add", agentId: id }).changedPaths).toEqual([]);
    expect(() => applyConfigChange(added, { ...change({}), kind: "unset", path: "desktop.keepAgentIds" })).toThrow();
    const replaced = applyConfigChange(added, { ...change({}), kind: "set", path: "desktop.keepAgentIds", value: [], replaceArrays: true, confirm: true, expectedRevision: configRevision(added) });
    expect(replaced.document.desktop?.keepAgentIds).toEqual([]);
  });
  test("strict desktop bounds and independent dependency revisions", () => {
    const before = defaultConfig();
    expect(() => applyConfigChange(before, { ...change({}), kind: "set", path: "desktop.idleReclaim.minIdleMs", value: 300000 })).toThrow();
    const after = applyConfigChange(before, { ...change({}), kind: "set", path: "desktop.idleReclaim.minIdleMs", value: 600000 }).document;
    const a = configurationRevisions(before); const b = configurationRevisions(after);
    expect(a.config).not.toBe(b.config); expect(a.desktop).not.toBe(b.desktop);
    expect(a.ops).toBe(b.ops); expect(a.targets).toEqual(b.targets); expect(a.runtime).toBe(b.runtime); expect(a.storage).toBe(b.storage);
  });
  test("filesystem policy rejects protected roots hidden behind harmless path segments", () => {
    for (const path of ["/proc", "/./proc", "//sys/./kernel", "/dev//shm", "/run/.", "/./", "/tmp/../proc"]) {
      expect(() => validateConfig({ ...defaultConfig(), daemon: { filesystem: { roots: [{ name: "files", path, operations: ["read"] }] } } }), path).toThrow("Unsafe filesystem root");
    }
    expect(() => validateConfig({ ...defaultConfig(), daemon: { filesystem: { roots: [{ name: "files", path: "/workspace/./files", operations: ["read"] }] } } })).not.toThrow();
  });
  test("client-only and target scopes cannot modify the wrong domain", () => {
    expect(() => applyConfigChange(defaultConfig(), { operationId: "client", scope: "client", kind: "set", path: "ops.enabled", value: true })).toThrow("Box");
    expect(() => applyConfigChange(defaultConfig(), { operationId: "target", scope: "target", kind: "set", path: "client.profiles.default.transport", value: "local" })).toThrow("Client");
  });
  test("preset never creates authority, preserves explicit choices, and cost increases require confirmation", () => {
    const document = validateConfig({ ...defaultConfig(), ops: { enabled: false, monitor: { deepReplay: false } } });
    const next = applyConfigChange(document, { ...change({}), kind: "preset", preset: "maintainer", confirm: true }).document;
    const effective = effectiveOps(next.ops);
    expect(effective.enabled).toBe(false); expect((effective.monitor as Record<string, unknown>).deepReplay).toBe(false);
    expect((effective.maintenance as Record<string, unknown>).mode).toBe("off");
    expect((effective.diagnostics as Record<string, unknown>).mode).toBe("on-request");
    expect(() => applyConfigChange(next, { ...change({}), kind: "set", path: "ops.diagnostics.mode", value: "automatic-bounded" })).toThrow("confirmation");
  });
  test("removing an off override cannot silently enable paid automation", () => {
    const doc = validateConfig({ ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" }, targets: { default: { enabled: false } } } });
    for (const path of ["ops.enabled", "ops.notifications.mode", "ops.targets.default.enabled"]) {
      expect(() => applyConfigChange(doc, { ...change({}), kind: "unset", path }), path).toThrow("confirmation");
      expect(() => applyConfigChange(doc, { ...change({}), kind: "unset", path, confirm: true }), path).not.toThrow();
    }
    expect(() => applyConfigChange(defaultConfig(), { ...change({}), kind: "set", path: "ops.notifications.digest", value: true })).toThrow("confirmation");
  });
  test("portable output strips identities and refs without inventing bindings", () => {
    const doc = validateConfig({ ...defaultConfig(), client: { currentProfile: "default", profiles: { default: { daemonTokenRef: "env:SECRET" } } }, ops: { targets: { default: { agentId: id } } }, storage: { diagnostics: { detailDays: 2 } } });
    const text = JSON.stringify(portableConfig(doc));
    expect(text).not.toContain("SECRET"); expect(text).not.toContain(id); expect(text).not.toContain("bindings");
  });
  test("cyclic and duplicate routes fail before persistence", () => {
    const route = (key: string, target: string, fallback: string) => ({ id: key, when: {}, action: { type: "deliver", target, fallbackTargets: [fallback] } });
    expect(() => validateConfig({ ...defaultConfig(), ops: { targets: { a: {}, b: {} }, routing: { defaultTarget: "a", rules: [route("first", "a", "b"), route("second", "b", "a")] } } })).toThrow("cycle");
  });
});
