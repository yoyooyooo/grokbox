import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, lstat, unlink, writeFile, chmod, link, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkContinuitySidecar, checkContinuityFile } from "../src/internal/io/continuity-files.node.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function retired() {
  const root = await mkdtemp(join(tmpdir(), "cont-sidecar-")); roots.push(root);
  const path = join(root, "state.sqlite-journal"), fd = await open(path, "wx", 0o600);
  try { await unlink(path); const stat = await fd.stat(); expect(stat.nlink).toBe(0); return { root, path, stat }; }
  finally { await fd.close(); }
}

test("a racing private retired journal is reobserved as absent, not accepted as a linked file", async () => {
  const f = await retired(); let calls = 0;
  const value = await checkContinuitySidecar(f.path, p => ++calls === 1 ? Promise.resolve(f.stat) : lstat(p));
  expect(value).toBeNull(); expect(calls).toBe(2);
});

test("a fresh journal after the old inode was retired must satisfy the original private-file checks", async () => {
  const f = await retired(); await writeFile(f.path, "replacement", { mode: 0o600 }); let calls = 0;
  const value = await checkContinuitySidecar(f.path, p => ++calls === 1 ? Promise.resolve(f.stat) : lstat(p));
  expect(value!.nlink).toBe(1); expect(value!.size).toBe(11); expect(calls).toBe(2);
});

for (const unsafe of ["permissions", "hardlink", "symlink"] as const) test(`retired journal cannot hide an unsafe ${unsafe} replacement`, async () => {
  const f = await retired(), other = join(f.root, "other");
  await writeFile(other, "other", { mode: 0o600 });
  if (unsafe === "hardlink") await link(other, f.path);
  else if (unsafe === "symlink") await symlink(other, f.path);
  else { await writeFile(f.path, "replacement", { mode: 0o600 }); await chmod(f.path, 0o644); }
  let calls = 0;
  await expect(checkContinuitySidecar(f.path, p => ++calls === 1 ? Promise.resolve(f.stat) : lstat(p))).rejects.toMatchObject({ code: "unsafe_path" });
  expect(calls).toBe(2);
});

test("persistent churn is bounded busy, while an unsafe first sample is never retried", async () => {
  const f = await retired(); let calls = 0;
  await expect(checkContinuitySidecar(f.path, async () => { calls++; return f.stat; })).rejects.toMatchObject({ code: "busy" });
  expect(calls).toBe(2);
  await writeFile(f.path, "public", { mode: 0o600 }); await chmod(f.path, 0o644); calls = 0;
  await expect(checkContinuitySidecar(f.path, p => { calls++; return lstat(p); })).rejects.toMatchObject({ code: "unsafe_path" });
  expect(calls).toBe(1);
});

test("the transient exception does not change persistent file semantics or permit arbitrary paths", async () => {
  const f = await retired(), path = join(f.root, "state.sqlite"); let calls = 0;
  await expect(checkContinuitySidecar(path, async () => { calls++; return f.stat; })).rejects.toMatchObject({ code: "invalid_material" });
  expect(calls).toBe(0);
  await writeFile(path, "source", { mode: 0o600 }); await link(path, join(f.root, "duplicate"));
  await expect(checkContinuityFile(path, true)).rejects.toMatchObject({ code: "unsafe_path" });
});
