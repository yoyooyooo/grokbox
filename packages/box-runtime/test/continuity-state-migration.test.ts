import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";

const scopeId = "a".repeat(64), agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("explicit CONT v1 upgrade preserves unknown operations; GET never performs the upgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-schema-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId }); await store.initialize();
    const operationId = randomUUID(), effectId = randomUUID(), policyRevision = "c".repeat(64);
    await store.prepareEffect({ operationId, agentId, kind: "initialize", policyRevision, inputDigest: "b".repeat(64), snapshotId: null });
    await store.claimEffect(operationId, effectId, policyRevision);
    const db = await openMonitorSqlite(join(root, "continuity", "state.sqlite"), "write");
    try {
      await db.run("ALTER TABLE operations DROP COLUMN request_json; UPDATE continuity_meta SET version=1; PRAGMA user_version=1;");
    } finally { await db.close(); }
    await expect(store.operation(operationId)).rejects.toThrow("schema_mismatch");
    const before = await openMonitorSqlite(join(root, "continuity", "state.sqlite"), "read");
    try { expect((await before.first("PRAGMA user_version"))?.user_version).toBe(1); } finally { await before.close(); }
    expect(await store.initialize()).toMatchObject({ initialized: true, created: false, migrated: true });
    expect(await store.operation(operationId)).toMatchObject({ state: "effect_unknown", effectId });
    await expect(store.initializationRequest(operationId)).rejects.toThrow("not_found");
    expect((await store.claimEffect(operationId, effectId, policyRevision)).dispatch).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
