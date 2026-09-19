import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { launchPackedRuntime, processDeadline, closePackedRuntime } from "./fixtures/packed-runtime-process.ts";

test("real packaged modeld resumes only its registered dead socket after SIGKILL, with a new service epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-persisted-restart-")), root = join(dir, "durable"), run = join(dir, "run");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify(defaultConfig()), { mode: 0o600 });
  let current: ReturnType<typeof launchPackedRuntime> | undefined;
  try {
    current = launchPackedRuntime(dir, ["modeld", "run"], root);
    const first = await processDeadline(current.ready);
    const socket = join(run, "modeld.sock"), firstInode = (await stat(socket)).ino;
    const config = await readFile(join(root, "config.json"));
    current.child.kill("SIGKILL"); await processDeadline(current.exit);
    expect((await stat(socket)).ino).toBe(firstInode);
    current = launchPackedRuntime(dir, ["modeld", "run"], root);
    const second = await processDeadline(current.ready);
    expect(second.data.generation).not.toBe(first.data.generation);
    // Inodes can be reused by the filesystem; new service epoch/owner is the
    // independent lifecycle assertion, not inequality of arbitrary inode values.
    const owner = JSON.parse(await readFile(`${socket}.owner.json`, "utf8"));
    expect(owner).toMatchObject({ generation: second.data.generation, pid: current.child.pid, state: "listening" });
    expect(await readFile(join(root, "config.json"))).toEqual(config);
    await closePackedRuntime(current); current = undefined;
    expect(await stat(socket).catch(() => null)).toBeNull();
  } finally { if (current) await closePackedRuntime(current); await rm(dir, { recursive: true, force: true }); }
}, 15000);
