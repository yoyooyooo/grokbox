import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";

const scopeId = "a".repeat(64), agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
for (const originalVersion of [1, 2, 3]) test(`retired CONT v${originalVersion} layout retains unknown effects without a read or initializer upgrade`, async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-schema-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId }); await store.initialize();
    const operationId = randomUUID(), effectId = randomUUID(), policyRevision = "c".repeat(64);
    await store.prepareEffect({ operationId, agentId, kind: "initialize", policyRevision, inputDigest: "b".repeat(64), snapshotId: null });
    await store.claimEffect(operationId, effectId, policyRevision);
    const db = await openMonitorSqlite(join(root, "continuity", "state.sqlite"), "write");
    try {
      if (originalVersion < 3) await db.run("ALTER TABLE operations DROP COLUMN result_json;");
      for (const table of ["continuity_workflow_materials", "continuity_subject_materials", "continuity_steps", "continuity_handover_items", "continuity_workflows", "continuity_subjects", "continuity_queued_controls"]) await db.run(`DROP TABLE ${table}`);
      if (originalVersion === 1) await db.run("ALTER TABLE operations DROP COLUMN request_json;");
      await db.run(`UPDATE continuity_meta SET version=${originalVersion}; PRAGMA user_version=${originalVersion};`);
    } finally { await db.close(); }
    const path = join(root, "continuity", "state.sqlite"), bytes = await readFile(path), names = await readdir(join(root, "continuity"));
    for (const operation of [() => store.operation(operationId), () => store.initialize(), () => store.initializationRequest(operationId),
      () => store.claimEffect(operationId, effectId, policyRevision)]) await expect(operation()).rejects.toThrow("schema_mismatch");
    expect(await readFile(path)).toEqual(bytes); expect(await readdir(join(root, "continuity"))).toEqual(names);
    const retained = await openMonitorSqlite(path, "read");
    try {
      expect((await retained.first("PRAGMA user_version"))?.user_version).toBe(originalVersion);
      expect(await retained.first("SELECT name FROM sqlite_master WHERE name='continuity_workflow_materials'")).toBeNull();
      expect(await retained.first("SELECT state,effect_id FROM operations WHERE operation_id=?", [operationId])).toEqual({ state: "effect_unknown", effect_id: effectId });
    } finally { await retained.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
