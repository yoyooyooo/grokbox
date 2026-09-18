import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withEventsLock, appendNdjsonLine } from "../src/internal/host/terminal-journal.node.ts";
import { withJournalLock, observeJournalLockStorage } from "../src/internal/host/journal-lock.node.ts";
import { inspectJournalSegments } from "../src/internal/host/journal-segments.node.ts";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
import { PACKED_SESSION_SYMBOL } from "../src/internal/host/profile.ts";

const worker = fileURLToPath(new URL("./fixtures/journal-lock-worker.ts", import.meta.url));
const linuxTest = process.platform === "linux" ? test : test.skip;
async function root() { return mkdtemp(join(tmpdir(), "journal-lock-test-")); }
async function bounded<T>(promise: Promise<T>, ms = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("owned_child_deadline")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function launch(directory: string, stage?: string) {
  const child = spawn(process.execPath, [worker, directory, ...(stage ? [stage] : [])], { cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", d => stderr = (stderr + d).slice(-4096));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", d => { if (String(d).includes(stage === "queued" ? '"started":true' : '"locked":true')) resolve(); else reject(Error("owned_invalid_ready")); });
    child.once("error", reject); child.once("exit", () => reject(Error("owned_child_before_ready")));
  });
  void ready.catch(() => undefined);
  const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
  return { child, ready, exit, stderr: () => stderr };
}
async function stop(c: ReturnType<typeof launch>) {
  if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL");
  await bounded(c.exit);
}
async function lockBytes(path: string) {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(path, name))]));
}

linuxTest("a real killed journal writer is recovered without replay, age guesses or leftover preparation directories", async () => {
  const directory = await root(), child = launch(directory);
  try {
    await bounded(child.ready);
    const lock = join(directory, "log/events.lock"); expect((await lstat(lock)).isDirectory()).toBe(true);
    const record = JSON.parse(String((await lockBytes(lock))[0]![1]));
    expect(record).toMatchObject({ schemaVersion: 2, pid: child.child.pid }); expect(record.start).toMatch(/^[a-f0-9]{64}$/);
    await stop(child);
    const deadBytes = await lockBytes(lock);
    const status = await observeJournalLockStorage(directory);
    expect(status).toMatchObject({ lockState: "directory-v2", ownerState: "process-absent" });
    expect(status.fileBytes).toBeGreaterThan(0); expect(status.allocatedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(record.token); expect(JSON.stringify(status)).not.toContain(record.start);
    expect(await lockBytes(lock)).toEqual(deadBytes);
    let ran = 0;
    await withEventsLock(directory, async () => { ran++; });
    expect(ran).toBe(1); expect(await readdir(join(directory, "log"))).toEqual([]);
    await appendNdjsonLine(directory, '{"name":"fixture","record":1}');
    expect(await readFile(join(directory, "log/events.ndjson"), "utf8")).toBe('{"name":"fixture","record":1}\n');
  } finally { await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 10000);

for (const stage of ["intent", "renamed", "created", "committed"] as const) linuxTest(`real process death at rotation ${stage} recovers both the mutex and the file protocol without replay`, async () => {
  const directory = await root(); let child: ReturnType<typeof launch> | undefined;
  try {
    for (const value of [0, 1]) await appendNdjsonLine(directory, JSON.stringify({ name: "fixture", value, padding: "x".repeat(700) }), "host", { policy: { segmentBytes: 2048, maxBytes: 8192 } });
    child = launch(directory, stage); await bounded(child.exit);
    expect(child.child.signalCode, child.stderr()).toBe("SIGKILL");
    await appendNdjsonLine(directory, JSON.stringify({ name: "fixture", value: 1000 }), "host", { policy: { segmentBytes: 2048, maxBytes: 8192 } });
    const inventory = await inspectJournalSegments(directory);
    expect(inventory.pending).toBe(false);
    const values: number[] = [];
    for (const segment of inventory.entries) for (const line of (await readFile(segment.path, "utf8")).trim().split("\n")) {
      const row = JSON.parse(line); if (typeof row.value === "number") values.push(row.value);
    }
    expect(values).toEqual([0, 1, 1000]);
    expect((await readdir(join(directory, "log"))).some(name => name === "events.lock" || name.startsWith("events.prepare-"))).toBe(false);
  } finally { if (child) await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 10000);

linuxTest("a living writer cannot be displaced even by repeated maintenance-style one-shot attempts", async () => {
  const directory = await root(), child = launch(directory);
  try {
    await bounded(child.ready);
    const path = join(directory, "log/events.lock"), before = await lockBytes(path);
    let ran = false;
    for (let n = 0; n < 8; n++) await expect(withEventsLock(directory, async () => { ran = true; }, 1)).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(ran).toBe(false); expect(await lockBytes(path)).toEqual(before);
    expect(await observeJournalLockStorage(directory)).toMatchObject({ lockState: "directory-v2", ownerState: "live", accountingComplete: true });
    expect((await readdir(join(directory, "log"))).filter(name => name.startsWith("events.prepare-"))).toEqual([]);
  } finally { await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 10000);

linuxTest("concurrent recoverers serialize their callbacks and release only their own unique lock", async () => {
  const directory = await root(), child = launch(directory);
  try {
    await bounded(child.ready); await stop(child);
    let active = 0, peak = 0, finished = 0;
    await Promise.all(Array.from({ length: 24 }, () => withEventsLock(directory, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--; finished++;
    })));
    expect(peak).toBe(1); expect(finished).toBe(24); expect(await readdir(join(directory, "log"))).toEqual([]);
  } finally { await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 10000);

linuxTest("a dead queued contender's bounded preparation slot is reclaimed on a subsequent acquisition", async () => {
  const directory = await root(); let child: ReturnType<typeof launch> | undefined;
  try {
    await withEventsLock(directory, async () => {
      child = launch(directory, "queued");
      await bounded(child.ready);
      let prepared = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const names = (await readdir(join(directory, "log"))).filter(name => name.startsWith("events.prepare-"));
        for (const name of names) {
          try {
            const record = JSON.parse(String((await lockBytes(join(directory, "log", name)))[0]![1]));
            if (record.pid === child.child.pid) prepared = true;
          } catch { /* the candidate is still writing its bounded owner record */ }
        }
        if (prepared) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(prepared, child.stderr()).toBe(true); await stop(child);
    });
    await withEventsLock(directory, async () => undefined);
    expect(await readdir(join(directory, "log"))).toEqual([]);
  } finally { if (child) await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 10000);

for (const kind of ["legacy-pid", "unknown-empty-directory", "symlink"] as const) test(`unqualified ${kind} is preserved rather than inferred to be a stale v2 lock`, async () => {
  const directory = await root();
  try {
    const log = join(directory, "log"), path = join(log, "events.lock"); await mkdir(log, { mode: 0o700 });
    if (kind === "legacy-pid") await writeFile(path, "2147483647\n", { mode: 0o600 });
    else if (kind === "unknown-empty-directory") await mkdir(path, { mode: 0o700 });
    else { await writeFile(join(directory, "victim"), "USER_DATA"); await symlink(join(directory, "victim"), path); }
    const before = await lstat(path);
    await expect(withEventsLock(directory, async () => { throw Error("must_not_acquire"); }, 1)).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect((await lstat(path)).ino).toBe(before.ino);
    if (kind === "legacy-pid") expect(await readFile(path, "utf8")).toBe("2147483647\n");
    if (kind === "symlink") expect(await readFile(join(directory, "victim"), "utf8")).toBe("USER_DATA");
    expect(await readdir(log)).toEqual(["events.lock"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("callback EEXIST is not retried, and an incomplete ownerless preparation namespace is bounded", async () => {
  const directory = await root(); try {
    let calls = 0;
    await expect(withEventsLock(directory, async () => { calls++; throw Object.assign(Error("callback_failure"), { code: "EEXIST" }); })).rejects.toThrow("callback_failure");
    expect(calls).toBe(1); expect(await readdir(join(directory, "log"))).toEqual([]);
    for (let slot = 0; slot < 64; slot++) await mkdir(join(directory, "log", `events.prepare-${slot}`), { mode: 0o700 });
    await expect(withJournalLock(join(directory, "log/events.lock"), async () => undefined, 1)).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect((await readdir(join(directory, "log"))).length).toBe(64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

linuxTest("the actual packed Node Host hook recovers the dead lock and records its first new hook event", async () => {
  const directory = await root(), child = launch(directory);
  try {
    await bounded(child.ready); await stop(child);
    const durable = join(directory, "durable"); await mkdir(durable);
    await writeFile(join(durable, "config.json"), JSON.stringify(defaultConfig()), { mode: 0o600 });
    await writeFile(join(durable, "models.json"), '{"version":2,"models":{},"assignments":{"main":null,"agents":{}}}', { mode: 0o600 });
    const script = `const [root,run,symbol]=process.argv.slice(1),fs=require('node:fs/promises');
const hook=globalThis[Symbol.for(symbol)].bindHostSessionHook({mode:'route',durableRoot:root,runRoot:run});
hook({agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionOptions:{invocationId:'post-crash-new-turn'},originalSession:{}});
(async()=>{for(let i=0;i<100;i++){let body='';try{body=await fs.readFile(run+'/log/events.ndjson','utf8')}catch{}
if(body.includes('post-crash-new-turn')){console.log('recovered');return;}await new Promise(r=>setTimeout(r,10));}process.exitCode=2;})();`;
    const cli = ensurePackedCli();
    const node = spawn("node", ["--require", join(cli, "..", "preload.cjs"), "-e", script, durable, directory, PACKED_SESSION_SYMBOL], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory, GROKBOX_PACKED_SESSION_FACTORY: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    let stdout = "", stderr = ""; node.stdout.on("data", d => stdout += d); node.stderr.on("data", d => stderr += d);
    const exit = await bounded(new Promise<number | null>((resolve, reject) => { node.once("close", resolve); node.once("error", reject); }));
    expect(exit, stderr).toBe(0); expect(stdout.trim()).toBe("recovered");
    expect((await readdir(join(directory, "log"))).some(name => name === "events.lock" || name.startsWith("events.prepare-"))).toBe(false);
  } finally { await stop(child); await rm(directory, { recursive: true, force: true }); }
}, 15000);
