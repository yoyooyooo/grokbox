import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
import { readContinuityIdentity } from "../src/internal/io/continuity-database.node.ts";
import { openRoutineProvisionStore } from "../src/internal/io/routine-provision.node.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId = "b".repeat(64);
async function editOwnedDatabase(path: string, statements: string) {
  const db = await openMonitorSqlite(path, "write");
  try { await db.run(`BEGIN IMMEDIATE; ${statements}; COMMIT;`); }
  finally { await db.close(); }
}
async function fingerprint(path: string) {
  return { bytes: await readFile(path), entries: (await readdir(dirname(path))).sort() };
}

for (const version of [1, 2, 3, 4, 6]) test(`observation v${version}: every owner entry refuses, without upgrading or replacing retained evidence`, async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-contract-"));
  try {
    const store = openMonitorStore(root), epoch = randomUUID();
    await store.initialize(); await store.begin(epoch, Date.now(), []);
    await editOwnedDatabase(store.path, `UPDATE meta SET version=${version}; PRAGMA user_version=${version}`);
    const before = await fingerprint(store.path);
    for (const operation of [() => store.snapshot(), () => store.incidents(), () => store.notificationWork(),
      () => store.evidenceCursor("source"), () => store.storageHealth(), () => store.initialize(), () => store.finish(epoch, Date.now())]) {
      await expect(operation()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
      expect(await fingerprint(store.path)).toEqual(before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("observation validates the physical header as well as metadata; a current-looking row cannot authorize an old file", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-header-"));
  try {
    const store = openMonitorStore(root); await store.initialize();
    await editOwnedDatabase(store.path, "PRAGMA user_version=3");
    const before = await fingerprint(store.path);
    await expect(store.snapshot()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    await expect(store.initialize()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    expect(await fingerprint(store.path)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lost observation ledger is not rebuilt into permission to replay retained notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-lost-"));
  try {
    const store = openMonitorStore(root); await store.initialize();
    const preserved = join(dirname(store.path), "retained.sqlite"), bytes = await readFile(store.path);
    await rename(store.path, preserved);
    await expect(store.initialize()).rejects.toThrow("monitor_store_unavailable");
    expect(await readFile(preserved)).toEqual(bytes);
    expect(await readdir(dirname(store.path))).toEqual(["retained.sqlite"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an existing empty observation owner is an incomplete initialization, not a new installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-incomplete-"));
  try {
    await mkdir(join(root, "observability"), { mode: 0o700 });
    await expect(openMonitorStore(root).initialize()).rejects.toThrow("monitor_store_unavailable");
    expect(await readdir(join(root, "observability"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed first publication preserves a foreign entry and cannot retry by clearing its owner directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-partial-")), path = join(root, "observability", "preserve.txt");
  try {
    const store = openMonitorStore(root, { beforePublish: () => { writeFileSync(path, "retained-evidence", { mode: 0o600 }); throw Error("injected-before-publication"); } });
    await expect(store.initialize()).rejects.toThrow("monitor_initialization_failed");
    expect(await readFile(path, "utf8")).toBe("retained-evidence");
    await expect(openMonitorStore(root).initialize()).rejects.toThrow("monitor_store_unavailable");
    expect(await readdir(dirname(path))).toEqual(["preserve.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent first initializers publish one database identity, not replacement histories", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-concurrent-"));
  try {
    const results = await Promise.allSettled([openMonitorStore(root).initialize(), openMonitorStore(root).initialize()]);
    const succeeded = results.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
    expect(succeeded.filter(r => r.created)).toHaveLength(1);
    expect(new Set(succeeded.map(r => r.databaseId)).size).toBe(1);
    for (const result of results) if (result.status === "rejected") {
      expect(["monitor_writer_busy", "monitor_store_unavailable"]).toContain(result.reason.message);
    }
    const store = openMonitorStore(root), before = await fingerprint(store.path);
    expect((await store.initialize()).databaseId).toBe(succeeded[0]!.databaseId);
    expect(await fingerprint(store.path)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current observation initialization is an identity check, not a write or a collector restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-observation-reopen-"));
  try {
    const store = openMonitorStore(root), first = await store.initialize(), epoch = randomUUID();
    await store.begin(epoch, Date.now(), []);
    const before = await fingerprint(store.path); let publications = 0;
    const reopened = openMonitorStore(root, { beforePublish: () => { publications++; }, afterRename: () => { publications++; } });
    expect(await reopened.initialize()).toEqual({ databaseId: first.databaseId, created: false });
    expect((await reopened.snapshot()).collectorEpoch).toBe(epoch);
    expect(publications).toBe(0); expect(await fingerprint(store.path)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const version of [1, 2, 3, 5]) test(`CONT v${version}: initialization cannot upgrade or consume an unknown native effect`, async () => {
  const root = await mkdtemp(join(tmpdir(), "current-cont-contract-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId }); await store.initialize();
    const operationId = randomUUID(), effectId = randomUUID(), policyRevision = "c".repeat(64);
    await store.prepareEffect({ operationId, agentId, kind: "initialize", policyRevision, inputDigest: "d".repeat(64), snapshotId: null });
    await store.claimEffect(operationId, effectId, policyRevision);
    const path = join(root, "continuity", "state.sqlite");
    await editOwnedDatabase(path, `UPDATE continuity_meta SET version=${version}; PRAGMA user_version=${version}`);
    const before = await fingerprint(path);
    for (const operation of [() => readContinuityIdentity(root), () => store.initialize(), () => store.operation(operationId),
      () => store.claimEffect(operationId, effectId, policyRevision)]) {
      await expect(operation()).rejects.toThrow("schema_mismatch");
      expect(await fingerprint(path)).toEqual(before);
    }
    const db = await openMonitorSqlite(path, "read");
    try { expect(await db.first("SELECT state,effect_id FROM operations WHERE operation_id=?", [operationId])).toEqual({ state: "effect_unknown", effect_id: effectId }); }
    finally { await db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current CONT initializer leaves original unknown receipts and database bytes alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-cont-reopen-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId }); await store.initialize();
    const operationId = randomUUID(), effectId = randomUUID(), policyRevision = "c".repeat(64);
    await store.prepareEffect({ operationId, agentId, kind: "initialize", policyRevision, inputDigest: "d".repeat(64), snapshotId: null });
    await store.claimEffect(operationId, effectId, policyRevision);
    const path = join(root, "continuity", "state.sqlite"), before = await fingerprint(path);
    expect(await openContinuityRecoveryStore({ durableRoot: root, scopeId }).initialize()).toEqual({ initialized: true, created: false });
    expect(await store.operation(operationId)).toMatchObject({ state: "effect_unknown", effectId });
    expect(await fingerprint(path)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const version of [1, 2, 4]) test(`Routine ledger v${version}: old rows cannot become absent or authorize a fresh dispatch`, async () => {
  const root = await mkdtemp(join(tmpdir(), "current-routine-contract-"));
  try {
    const store = openRoutineProvisionStore(root), operationId = randomUUID();
    const input = { agentId, operationId, key: "notice", action: "create" as const, binding: null,
      fingerprint: "c".repeat(64), desiredDigest: "d".repeat(64), atMs: Date.now() };
    expect((await store.reserve(input)).dispatch).toBe(true);
    await editOwnedDatabase(store.path, `${version < 3 ? "DROP TABLE state_operations;" : ""}${version < 2 ? "DROP TABLE operation_tombstones;" : ""} PRAGMA user_version=${version}`);
    const before = await fingerprint(store.path);
    for (const operation of [() => store.read(agentId, operationId), () => store.stateRecord(agentId, operationId),
      () => store.status(), () => store.binding(agentId, "notice"), () => store.reserve(input),
      () => store.reserve({ ...input, operationId: randomUUID() })]) {
      await expect(operation()).rejects.toMatchObject({ reason: "ledger_unavailable" });
      expect(await fingerprint(store.path)).toEqual(before);
    }
    const db = await openMonitorSqlite(store.path, "read");
    try { expect(await db.first("SELECT state,operation_id FROM operations")).toEqual({ state: "attempting", operation_id: operationId }); }
    finally { await db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
