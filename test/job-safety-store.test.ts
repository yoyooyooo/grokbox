import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { JobManager, GovernedFilesystem, ProcessAuthority } from "@grokbox/box-runtime/runtime";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "job-safety-")), workspace = join(root, "workspace");
  await mkdir(workspace); let now = Date.now();
  const authority = await ProcessAuthority.create({ cwdRoots: ["workspace"], defaultCwdRoot: "workspace", executables: [{ name: "node", path: await realpath(Bun.which("node")!) }],
    environment: [], maxConcurrent: 1, maxQueued: 2, maxRuntimeMs: 10000, maxOutputBytes: 65536 });
  const filesystem = await GovernedFilesystem.create([{ name: "workspace", path: workspace, operations: ["exec"] }], () => now);
  const create = () => JobManager.create(root, authority, filesystem, () => now);
  return { root, workspace, create, advance: () => { now += 2 * 24 * 3600000; },
    request: (jobId = randomUUID()) => ({ jobId, argv: ["node", "-e", "process.stdout.write('once')"], environment: {}, output: "capture" as const, shell: false, runTimeoutMs: 5000 }),
    close: async () => { await filesystem.close(); await rm(root, { recursive: true, force: true }); } };
}

test("history retention cannot erase execution identity and authorize the original request again", async () => {
  const f = await fixture(); let manager: JobManager | undefined;
  try {
    manager = await f.create(); const request = f.request(); await manager.submit(request);
    const completed = await manager.waitTerminal(request.jobId, 5000); expect(completed.state).toBe("succeeded");
    await manager.close(); manager = undefined; f.advance(); manager = await f.create();
    expect(manager.show(request.jobId).state).toBe("succeeded");
    expect((await manager.submit(request)).state).toBe("succeeded");
  } finally { await manager?.close(); await f.close(); }
});

test("corrupt job state is preserved, not overwritten by a fabricated unknown receipt", async () => {
  const f = await fixture(); let manager: JobManager | undefined;
  try {
    manager = await f.create(); const request = f.request(); await manager.submit(request); await manager.waitTerminal(request.jobId, 5000);
    await manager.close(); manager = undefined; const path = join(f.root, "jobs", request.jobId, "state.json");
    await writeFile(path, "{retained-torn-state", { mode: 0o600 });
    try { manager = await f.create(); } catch { /* A corrupt safety owner may refuse acquisition. */ }
    expect(await readFile(path, "utf8")).toBe("{retained-torn-state");
  } finally { await manager?.close(); await f.close(); }
});

test("two service owners cannot load and dispatch through the same Job ledger", async () => {
  const f = await fixture(); let first: JobManager | undefined, second: JobManager | undefined;
  try {
    first = await f.create();
    await expect(f.create().then(value => { second = value; return value; })).rejects.toThrow();
  } finally { await second?.close(); await first?.close(); await f.close(); }
});
