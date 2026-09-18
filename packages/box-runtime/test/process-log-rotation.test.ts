import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openBoundedProcessLog, observeProcessLogStorage, type BoundedProcessLog } from "../src/internal/io/bounded-process-log.node.ts";

const now = 1_789_700_000_000;
const policy = { segmentBytes: 2048, maxBytes: 8192, maxAgeMs: 72 * 3_600_000 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "process-log-rotation-"));
  return { root, dir: join(root, "log", "process"), close: () => rm(root, { recursive: true, force: true }) };
}
async function diskBytes(dir: string) {
  let bytes = 0;
  for (const name of await readdir(dir)) bytes += (await stat(join(dir, name))).size;
  return bytes;
}

test("the writer rotates its real fd and remains bounded through 25 generations without a cleanup daemon", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    let lastSequence = 0;
    for (let cycle = 0; cycle < 25; cycle++) {
      logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now + cycle * 100, policy });
      for (let i = 0; i < 30; i++) {
        expect(await logger.append({ event: "ready", atMs: now + cycle * 100 + i })).toBe("written");
        expect(await diskBytes(f.dir)).toBeLessThanOrEqual(policy.maxBytes);
      }
      expect(logger.health().writtenRecords).toBe(30);
      await logger.close(); logger = undefined;
      const usage = await observeProcessLogStorage(f.root);
      expect(usage.state).toBe("available"); expect(usage.segments.length).toBeLessThanOrEqual(4);
      expect(usage.bytes).toBe(await diskBytes(f.dir));
      expect(usage.segments.at(-1)!.sequence).toBeGreaterThan(lastSequence);
      lastSequence = usage.segments.at(-1)!.sequence;
      for (const name of await readdir(f.dir)) {
        const lines = (await readFile(join(f.dir, name), "utf8")).trimEnd().split("\n");
        expect(JSON.parse(lines[0]!).format).toBe("grokbox.modeld-process-log");
        for (const line of lines.slice(1)) expect(JSON.parse(line).kind).toBe("modeld_process_event");
      }
    }
  } finally { await logger?.close(); await f.close(); }
});

test("restart preserves a crashed partial tail in its old segment instead of appending to it", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy });
    await logger.append({ event: "ready", atMs: now }); await logger.close(); logger = undefined;
    const old = join(f.dir, (await readdir(f.dir))[0]!);
    await appendFile(old, '{"partial":'); const before = await readFile(old);
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now + 1, policy });
    await logger.append({ event: "ready", atMs: now + 1 });
    expect(await readFile(old)).toEqual(before);
    expect((await observeProcessLogStorage(f.root)).segments).toHaveLength(2);
  } finally { await logger?.close(); await f.close(); }
});

test("raw text, exception causes and coercion hooks never enter lifecycle logs", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy });
    let invoked = 0;
    const input = { event: "ready", atMs: now, message: "PRIVATE_SENTINEL", cause: { token: "PRIVATE_SENTINEL" },
      get endpoint() { invoked++; throw new Error("PRIVATE_SENTINEL"); } };
    expect(await logger.append(input)).toBe("written");
    expect(await logger.append({ get event() { invoked++; return "ready"; }, atMs: now })).toBe("dropped");
    expect(invoked).toBe(0);
    for (const name of await readdir(f.dir)) expect(await readFile(join(f.dir, name), "utf8")).not.toContain("PRIVATE_SENTINEL");
    expect(logger.health().droppedRecords).toBe(1);
  } finally { await logger?.close(); await f.close(); }
});

test("concurrent diagnostic offers drop rather than build an unbounded pending-write queue", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy });
    const results = await Promise.all(Array.from({ length: 400 }, () => logger!.append({ event: "ready", atMs: now })));
    expect(results.filter(r => r === "written")).toHaveLength(1);
    expect(results.filter(r => r === "dropped")).toHaveLength(399);
    expect(logger.health()).toMatchObject({ state: "available", writtenRecords: 1, droppedRecords: 399 });
  } finally { await logger?.close(); await f.close(); }
});

test("replacement of an active pathname cannot redirect the held writer into a symlink victim", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy });
    const active = join(f.dir, (await readdir(f.dir))[0]!), moved = join(f.root, "saved-segment");
    const victim = join(f.root, "unrelated-user-file"); await writeFile(victim, "UNCHANGED");
    await rename(active, moved); await symlink(victim, active);
    expect(await logger.append({ event: "ready", atMs: now })).toBe("unavailable");
    expect(await readFile(victim, "utf8")).toBe("UNCHANGED");
    expect(logger.health()).toMatchObject({ state: "unavailable", reason: "storage_unavailable" });
  } finally { await logger?.close(); await f.close(); }
});

test("unknown existing files in an owned slot are preserved; storage GET never initializes or repairs", async () => {
  const f = await fixture();
  try {
    expect((await observeProcessLogStorage(f.root)).state).toBe("missing"); expect(await readdir(f.root)).toEqual([]);
    await mkdir(join(f.root, "log"), { mode: 0o700 }); await mkdir(f.dir, { mode: 0o700 });
    const unknown = join(f.dir, "modeld.000.ndjson"); await writeFile(unknown, "unrecognized file\n", { mode: 0o600 });
    const before = await readFile(unknown);
    await expect(openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy })).rejects.toThrow();
    expect((await observeProcessLogStorage(f.root)).state).toBe("unavailable"); expect(await readFile(unknown)).toEqual(before);
    expect(await readdir(f.dir)).toEqual(["modeld.000.ndjson"]);
  } finally { await f.close(); }
});

test("TTL and policy reduction prune only registered closed segments; legacy raw file and user files survive", async () => {
  const f = await fixture(); let logger: BoundedProcessLog | undefined;
  try {
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now, policy });
    for (let i = 0; i < 50; i++) await logger.append({ event: "ready", atMs: now + i });
    await logger.close(); logger = undefined;
    await writeFile(join(f.root, "log", "modeld-process.log"), "OLD_RAW_UNCHANGED");
    await writeFile(join(f.dir, "user-export.json"), "USER_UNCHANGED");
    logger = await openBoundedProcessLog({ runRoot: f.root, generation: randomUUID(), nowMs: now + policy.maxAgeMs + 100,
      policy: { ...policy, maxBytes: 4096 } });
    expect((await observeProcessLogStorage(f.root)).segments).toHaveLength(1);
    expect(await readFile(join(f.root, "log", "modeld-process.log"), "utf8")).toBe("OLD_RAW_UNCHANGED");
    expect(await readFile(join(f.dir, "user-export.json"), "utf8")).toBe("USER_UNCHANGED");
  } finally { await logger?.close(); await f.close(); }
});
