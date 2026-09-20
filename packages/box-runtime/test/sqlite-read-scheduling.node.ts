import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openMonitorSqlite, type MonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sqlite-read-scheduling-"));
  const file = join(root, "state.sqlite"), connections: MonitorSqlite[] = [];
  const writer = await openMonitorSqlite(file, "create"); connections.push(writer);
  await writer.run("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sample VALUES(1,'original');");
  const reader = async () => { const db = await openMonitorSqlite(file, "read"); connections.push(db); return db; };
  return { root, file, writer, reader, close: async () => {
    await writer.run("ROLLBACK").catch(() => undefined);
    for (const db of connections.reverse()) await db.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test("a busy reader releases the sole libuv worker so the owning writer can commit", async () => {
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  const f = await fixture();
  try {
    const reader = await f.reader();
    await f.writer.run("BEGIN EXCLUSIVE; UPDATE sample SET value='committed' WHERE id=1;");
    // Record rejection immediately: the old blocking busy handler exhausts its
    // budget before the writer COMMIT can even enter the same worker pool.
    const pending = reader.first("SELECT value FROM sample WHERE id=1").then(value => ({ value }), error => ({ error }));
    await delay(30); await f.writer.run("COMMIT");
    const result = await pending;
    assert.ok(!("error" in result), "Read lock waiting must not starve the write that releases the lock.");
    assert.equal(result.value?.value, "committed");
  } finally { await f.close(); }
});

test("opening read-only connections during a committing writer remains cooperative", async () => {
  const f = await fixture();
  try {
    await f.writer.run("BEGIN EXCLUSIVE; UPDATE sample SET value='opened' WHERE id=1;");
    const tasks = Array.from({ length: 8 }, async () => {
      const db = await f.reader(); return db.first("SELECT value FROM sample");
    });
    const pending = Promise.allSettled(tasks);
    await delay(30); await f.writer.run("COMMIT");
    const results = await pending;
    assert.ok(results.every(r => r.status === "fulfilled" && r.value?.value === "opened"));
  } finally { await f.close(); }
});

test("a genuinely held lock still returns its bounded busy failure and does not retry a write", async () => {
  const f = await fixture();
  try {
    const reader = await f.reader(); await f.writer.run("BEGIN EXCLUSIVE");
    const began = performance.now();
    await assert.rejects(reader.first("SELECT value FROM sample"), (e: any) => e.code === "SQLITE_BUSY");
    assert.ok(performance.now() - began < 2500);
    await f.writer.run("ROLLBACK");
    await assert.rejects(reader.run("UPDATE sample SET value='forbidden'"), (e: any) => e.code === "SQLITE_READONLY");
    assert.equal((await reader.first("SELECT value FROM sample"))?.value, "original");
    await assert.rejects(reader.first("SELECT * FROM missing_table"), (e: any) => e.code === "SQLITE_ERROR");
  } finally { await f.close(); }
});

test("a pending read keeps its submitted bindings rather than a caller's later mutation", async () => {
  const f = await fixture();
  try {
    const reader = await f.reader(); await f.writer.run("BEGIN EXCLUSIVE");
    const params = [1];
    const pending = reader.first("SELECT value FROM sample WHERE id=?", params);
    await delay(30); params[0] = 2; await f.writer.run("COMMIT");
    assert.equal((await pending)?.value, "original");
  } finally { await f.close(); }
});

test("read transactions keep one snapshot and do not write database or sidecar files", async () => {
  const f = await fixture();
  try {
    const reader = await f.reader(), bytes = await readFile(f.file), info = await stat(f.file), files = await readdir(f.root);
    await reader.run("BEGIN");
    assert.equal((await reader.first("SELECT value FROM sample"))?.value, "original");
    assert.equal((await reader.first("SELECT COUNT(*) AS n FROM sample"))?.n, 1);
    await reader.run("ROLLBACK");
    assert.deepEqual(await readFile(f.file), bytes); assert.equal((await stat(f.file)).mtimeMs, info.mtimeMs);
    assert.deepEqual(await readdir(f.root), files);
  } finally { await f.close(); }
});
