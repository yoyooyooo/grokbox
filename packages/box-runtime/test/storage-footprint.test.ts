import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { observeDiagnosticFootprint } from "../src/internal/io/storage-footprint.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "storage-footprint-")), root = join(dir, "durable"), run = join(dir, "run");
  await mkdir(join(root, "observability"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "log"), { mode: 0o700 }); await mkdir(join(run, "log"), { recursive: true, mode: 0o700 });
  return { dir, root, run, input: { durableRoot: root, runRoot: run }, close: () => rm(dir, { recursive: true, force: true }) };
}

test("physical footprint includes backup/staging/auxiliary metadata without reading file contents or leaking filenames", async () => {
  const f = await fixture();
  try {
    const files = [join(f.root, "observability/observations.sqlite"), join(f.root, "observability/observations.sqlite-journal"),
      join(f.root, "observability/PRIVATE_BACKUP_NAME.sqlite"), join(f.root, "log/events.ndjson"), join(f.run, "log/storage-maintenance.next.json")];
    for (let n = 0; n < files.length; n++) await writeFile(files[n]!, Buffer.alloc((n + 1) * 19, 42), { mode: 0o600 });
    const bytes = (await Promise.all(files.map(p => stat(p)))).reduce((n, st) => n + st.size, 0);
    await link(files[0]!, join(f.run, "log/shared-copy"));
    const before = await Promise.all(files.map(p => readFile(p))), result = await observeDiagnosticFootprint(f.input);
    expect(result).toMatchObject({ state: "measured", fileBytes: bytes, installationCoverage: "partial", deletionAuthorized: false, installationBudgetEnforced: false });
    expect(result.allocatedBytes).toBeGreaterThanOrEqual(bytes);
    expect(result.scopes.reduce((n, s) => n + s.files, 0)).toBe(5);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BACKUP_NAME"); expect(JSON.stringify(result)).not.toContain(f.dir);
    expect(await Promise.all(files.map(p => readFile(p)))).toEqual(before);
    expect((await observeDiagnosticFootprint({ durableRoot: f.root, runRoot: f.root })).scopes).toHaveLength(2);
  } finally { await f.close(); }
});

test("symlink targets and deep trees are not traversed and missing coverage never looks complete", async () => {
  const f = await fixture();
  try {
    const victim = join(f.dir, "user-data"); await mkdir(victim); await writeFile(join(victim, "private"), Buffer.alloc(8000));
    await symlink(victim, join(f.root, "log/redirect"));
    await mkdir(join(f.root, "observability/a/b/c/d/e"), { recursive: true });
    await writeFile(join(f.root, "observability/a/b/c/d/e/deep"), Buffer.alloc(4000));
    const result = await observeDiagnosticFootprint(f.input);
    expect(result.state).toBe("partial"); expect(result.gaps).toContain("symlink_not_followed"); expect(result.gaps).toContain("depth_budget");
    expect(result.fileBytes).toBe(0); expect(result.countedEntries).toBeLessThanOrEqual(result.maxEntries);
    expect(await readdir(victim)).toEqual(["private"]);
  } finally { await f.close(); }
});

test("a tiny-file flood has a bounded inventory and no file is removed", async () => {
  const f = await fixture();
  try {
    for (let start = 0; start < 2080; start += 80) await Promise.all(Array.from({ length: 80 }, (_, n) => writeFile(join(f.root, "observability", `f-${start + n}`), "x", { mode: 0o600 })));
    const result = await observeDiagnosticFootprint(f.input);
    expect(result.state).toBe("partial"); expect(result.gaps).toContain("entry_budget"); expect(result.countedEntries).toBeLessThanOrEqual(2048);
    expect(await readdir(join(f.root, "observability"))).toHaveLength(2080);
  } finally { await f.close(); }
}, 10000);

test("status compares measured namespaces with requested budget but never claims reservation or full-installation coverage", async () => {
  const f = await fixture();
  try {
    const MIB = 1024 * 1024;
    const config = validateConfig({ ...defaultConfig(), storage: { diagnostics: { targetBytes: MIB, maxBytes: 4 * MIB, reserveBytes: MIB },
      retention: { monitor: { maxBytes: MIB }, journal: { segmentBytes: 128 * 1024, maxBytes: 256 * 1024 }, process: { segmentBytes: 2048, maxBytes: 4096 } } } });
    await writeFile(join(f.root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    const payload = join(f.root, "observability/unknown-backup.bin"); await writeFile(payload, Buffer.alloc(2 * MIB), { mode: 0o600 });
    const result = await observeRuntimeStorage(f.input);
    expect(result).toMatchObject({ state: "not_initialized", installationBudgetEnforced: false,
      budgetComparison: { state: "at_or_above_target", coverage: "partial", reservationEnforced: false } });
    expect(result.footprint.fileBytes).toBe(2 * MIB);
    expect(await stat(payload)).toMatchObject({ size: 2 * MIB });
  } finally { await f.close(); }
});
