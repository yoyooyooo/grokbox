import { expect, test } from "bun:test";
import { CONFIG_SCHEMA_VERSION, applyConfigChange, configSchemaAt, configurationRevisions, defaultConfig, effectiveOps, effectiveStorage,
  migrateConfigV2, migrateConfigV3, portableConfig, runtimeDesiredFromConfig, storageAllocation, validateConfig } from "../src/config.ts";

const MIB = 1024 * 1024;
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const legacy = () => ({ ...defaultConfig(), schemaVersion: 3, runtime: { desiredMode: "route" as const, context: { windowTokens: 64000 } },
  ops: { enabled: false, notifications: { mode: "off", maxAutomaticWakeupsPerDay: 0, criticalReservePerDay: 0 },
    targets: { default: { agentId: id, dataPolicy: "safe-summary" } },
    support: { offerIssue: true, submit: "preauthorized-summary", credentialRef: "env:PRIVATE_SUPPORT", repository: "example/project" } } });

test("current default has one versioned storage intent and no implicit Issue workflow", () => {
  const doc = defaultConfig(); expect(doc.schemaVersion).toBe(CONFIG_SCHEMA_VERSION); expect(CONFIG_SCHEMA_VERSION).toBe(4);
  const ops = effectiveOps(doc.ops);
  expect(ops.support).toBeUndefined(); expect(ops.notifications).toMatchObject({ mode: "actionable-user", maxAutomaticWakeupsPerDay: 2 });
  expect(ops.diagnostics).toEqual({ mode: "on-request" }); expect(ops.maintenance).toEqual({ mode: "off" });
  const storage = effectiveStorage(doc.storage);
  expect(storage.diagnostics).toEqual({ targetBytes: 256 * MIB, maxBytes: 512 * MIB, reserveBytes: 64 * MIB, detailDays: 7, summaryDays: 30 });
  expect(storageAllocation(storage)).toMatchObject({ dataBytes: 416 * MIB, reserveBytes: 64 * MIB, unallocatedBytes: 32 * MIB, journalRoots: 2, installationBudgetEnforced: false });
  expect(() => configSchemaAt(["ops", "support"])).toThrow();
});

test("explicit v3 migration retires only the known support domain and preserves off, costs, targets and runtime", () => {
  const old = legacy(), before = JSON.stringify(old);
  expect(() => validateConfig(old)).toThrow("migrate"); expect(() => runtimeDesiredFromConfig(old)).toThrow("migration");
  const next = migrateConfigV3(old);
  const { support: _, ...ops } = old.ops;
  expect(next).toEqual({ ...old, schemaVersion: 4, ops }); expect(JSON.stringify(old)).toBe(before);
  expect(next.ops).toMatchObject({ enabled: false, notifications: { mode: "off", maxAutomaticWakeupsPerDay: 0, criticalReservePerDay: 0 } });
  expect(runtimeDesiredFromConfig(next).mode).toBe("route"); expect(next.runtime?.context?.windowTokens).toBe(64000);
  expect(() => validateConfig({ ...next, ops: old.ops })).toThrow();
});

test("legacy unknown fields, raw credentials and future schemas are refused before any field is discarded", () => {
  const old = legacy();
  for (const value of [
    { ...old, unexpected: true }, { ...old, storage: {} }, { ...old, schemaVersion: 5 },
    { ...old, ops: { ...old.ops, surprise: true } },
    { ...old, ops: { ...old.ops, support: { ...old.ops.support, uploadPrompt: true } } },
    { ...old, ops: { ...old.ops, support: { ...old.ops.support, credentialRef: "RAW_SECRET" } } },
  ]) expect(() => migrateConfigV3(value)).toThrow();
  expect(migrateConfigV2({ ...defaultConfig(), schemaVersion: 2, ops: old.ops }).ops?.support).toBeUndefined();
  expect(() => migrateConfigV2({ ...old, schemaVersion: 2 })).toThrow();
});

for (const [name, storage] of Object.entries({
  unknown: { strange: true }, safety: { retention: { execution: { ttlMs: 1 } } },
  path: { retention: { journal: { path: "/unowned" } } }, revision: { policyRevision: 2 },
  negative: { diagnostics: { detailDays: -1 } }, coercion: { diagnostics: { summaryDays: "30" } },
  reversedAge: { diagnostics: { detailDays: 20, summaryDays: 10 } }, reserve: { diagnostics: { reserveBytes: 512 * MIB } },
  ownerOverflow: { diagnostics: { maxBytes: 300 * MIB, targetBytes: 200 * MIB } },
  segmentOverflow: { retention: { journal: { maxBytes: 8 * MIB } } },
  tooManySlots: { retention: { process: { segmentBytes: 2048 } } },
})) test(`storage rejects ${name} rather than normalizing into an unsafe policy`, () => {
  expect(() => validateConfig({ ...defaultConfig(), storage })).toThrow();
});

test("only the storage dependency revision changes; notification disable never removes storage intent", () => {
  const first = defaultConfig(), before = configurationRevisions(first);
  const second = validateConfig({ ...first, storage: { diagnostics: { detailDays: 2 } } }), after = configurationRevisions(second);
  expect(after.storage).not.toBe(before.storage);
  for (const key of ["client", "daemon", "desktop", "runtime", "ops", "targets"] as const) expect(after[key]).toEqual(before[key]);
  const disabled = validateConfig({ ...second, ops: { enabled: false, notifications: { mode: "off" } } });
  expect(configurationRevisions(disabled).storage).toBe(after.storage);
  expect(effectiveStorage(disabled.storage).diagnostics.detailDays).toBe(2);
});

test("storage lowering, raising and parent unset require explicit impact acknowledgement", () => {
  const document = defaultConfig();
  const write = { kind: "set" as const, operationId: "storage-test", scope: "box" as const, path: "storage.diagnostics.detailDays", value: 2 };
  expect(() => applyConfigChange(document, write)).toThrow("confirmation");
  const changed = applyConfigChange(document, { ...write, confirm: true }).document;
  expect(changed.storage?.diagnostics?.detailDays).toBe(2);
  expect(() => applyConfigChange(changed, { kind: "unset", operationId: "unset-storage", scope: "box", path: "storage" })).toThrow("confirmation");
  expect(() => applyConfigChange(document, { ...write, scope: "client", confirm: true })).toThrow("Box");
});

test("portable storage intent carries budgets, not usage, leases, privileged paths or identities", () => {
  const document = validateConfig({ ...defaultConfig(), storage: { diagnostics: { detailDays: 2 } }, ops: { targets: { default: { agentId: id } } } });
  const exported = portableConfig(document);
  expect(exported.storage).toEqual(document.storage); expect(JSON.stringify(exported)).not.toContain(id);
  expect(() => validateConfig({ ...document, storage: { ...document.storage, leases: [] } })).toThrow();
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "diagnostics", { enumerable: true, get: () => { getterCalls++; return {}; } });
  expect(() => effectiveStorage(hostile)).toThrow(); expect(getterCalls).toBe(0);
});
