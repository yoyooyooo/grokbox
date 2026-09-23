import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rename, rm, readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { captureHostSourceWindow, HOST_WINDOW_LIMITS, readHostSourceWindow } from "../packages/box-runtime/src/internal/io/host-source-window.node.mjs";
import { readStableSourceSet, sourceDigest } from "../packages/box-runtime/src/internal/io/stable-source-set.node.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "owned-host-window-"));
  const paths = { source: join(root, "source.cjs"), worker: join(root, "worker.cjs"), profile: null };
  await writeFile(paths.source, "module.exports = 'A';\n", { mode: 0o600 });
  await writeFile(paths.worker, "module.exports = 'a';\n", { mode: 0o600 });
  return { root, paths, parent: join(root, "windows"), close: () => rm(root, { recursive: true, force: true }) };
}
const bindings = { verificationSource: sourceDigest("owned-test-input"), testPlan: sourceDigest("finite-owned-suite") };

test("captured source survives installed replacement; freshness is independent and no qualification is invented", async () => {
  const f = await fixture(); const window = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent });
  try {
    expect((await window.freshness()).state).toBe("unchanged");
    const prior = readHostSourceWindow(window.env, "source").bytes!.toString();
    await writeFile(join(f.root, "replacement.cjs"), "module.exports = 'B';\n", { mode: 0o600 });
    await rename(join(f.root, "replacement.cjs"), f.paths.source);
    expect(await window.current()).toBe(true);
    expect(readHostSourceWindow(window.env, "source").bytes!.toString()).toBe(prior);
    expect(await window.freshness()).toMatchObject({ state: "changed", changedComponents: ["source"], qualified: false });
    expect(window.receipt).toMatchObject({ sourceSha: sourceDigest(prior), bindings, scope: "private-fixed-source-not-installed-or-loaded", qualified: false });
    expect(JSON.stringify(window.receipt)).not.toContain(f.paths.source);
  } finally { await window.dispose(); expect(await readdir(f.parent)).toEqual([]); await f.close(); }
});

test("worker-only same-size rewrite with restored mtime is visible while the exact captured worker remains usable", async () => {
  const f = await fixture(); const window = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent });
  try {
    const before = await stat(f.paths.worker);
    await writeFile(f.paths.worker, "module.exports = 'b';\n"); await utimes(f.paths.worker, before.atime, before.mtime);
    expect(await window.freshness()).toMatchObject({ state: "changed", changedComponents: ["worker"] });
    expect(readHostSourceWindow(window.env, "worker").bytes!.toString()).toContain("'a'");
    expect(await window.current()).toBe(true);
  } finally { await window.dispose(); await f.close(); }
});

test("read-mid-replace and same-size in-place rewrites fail the shared stable-read owner deterministically", async () => {
  const f = await fixture();
  try {
    for (const replacement of [false, true]) {
      await writeFile(f.paths.source, "module.exports = 'A';\n");
      await expect(readStableSourceSet([{ path: f.paths.source, maxBytes: 1024 }, { path: f.paths.worker, maxBytes: 1024 }], undefined, async index => {
        if (index !== 0) return;
        if (replacement) { await writeFile(join(f.root, "next"), "module.exports = 'B';\n", { mode: 0o600 }); await rename(join(f.root, "next"), f.paths.source); }
        else { const before = await stat(f.paths.source); await writeFile(f.paths.source, "module.exports = 'B';\n"); await utimes(f.paths.source, before.atime, before.mtime); }
      })).rejects.toMatchObject({ code: "source-changed" });
    }
  } finally { await f.close(); }
});

test("modified private bytes, wrong window key and incomplete child inheritance are refused", async () => {
  const f = await fixture(); const window = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent });
  try {
    expect(() => readHostSourceWindow({ GROKBOX_TEST_NATIVE_WINDOW: window.env.GROKBOX_TEST_NATIVE_WINDOW })).toThrow();
    expect(() => readHostSourceWindow({ ...window.env, GROKBOX_TEST_NATIVE_WINDOW_KEY: "f".repeat(64) })).toThrow();
    await chmod(window.paths.source, 0o600); await writeFile(window.paths.source, "module.exports = 'X';\n");
    expect(await window.current()).toBe(false);
    expect(() => readHostSourceWindow(window.env, "source")).toThrow("source-window-changed");
  } finally { await window.dispose(); await f.close(); }
});

test("slot and file-size limits fail closed; cleanup never evicts another invocation", async () => {
  const f = await fixture(), windows = [];
  try {
    for (let i = 0; i < HOST_WINDOW_LIMITS.slots; i++) windows.push(await captureHostSourceWindow(f.paths, bindings, { parent: f.parent }));
    await expect(captureHostSourceWindow(f.paths, bindings, { parent: f.parent })).rejects.toMatchObject({ code: "source-window-capacity" });
    for (const window of windows) expect(await window.current()).toBe(true);
    const released = windows.shift()!; await released.dispose();
    const replacement = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent }); windows.push(replacement);
    await expect(released.dispose()).rejects.toMatchObject({ code: "source-window-owner-changed" });
    expect(await replacement.current()).toBe(true);
    await expect(readStableSourceSet([{ path: f.paths.source, maxBytes: 1 }])).rejects.toMatchObject({ code: "source-unavailable" });
  } finally { await Promise.all(windows.map(window => window.dispose())); await f.close(); }
});

test("cancelled or failed captures settle descriptors and release their reserved slot", async () => {
  const f = await fixture();
  try {
    const aborted = new AbortController(); aborted.abort();
    await expect(captureHostSourceWindow(f.paths, bindings, { parent: f.parent, signal: aborted.signal })).rejects.toBeDefined();
    await rm(f.paths.worker);
    await expect(captureHostSourceWindow(f.paths, bindings, { parent: f.parent })).rejects.toBeDefined();
    expect(await readdir(f.parent)).toEqual([]);
    const controller = new AbortController();
    await expect(readStableSourceSet([{ path: f.paths.source, maxBytes: 1024 }], controller.signal, async () => controller.abort())).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("one captured window reaches a clean Node child even after the original source disappears", async () => {
  const f = await fixture(); const window = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent });
  try {
    await rm(f.paths.source); await rm(f.paths.worker);
    const module = new URL("../packages/box-runtime/src/internal/io/host-source-window.node.mjs", import.meta.url).href;
    const result = spawnSync("node", ["--input-type=module", "-e", `import {readHostSourceWindow} from ${JSON.stringify(module)}; const r=readHostSourceWindow(process.env); console.log(JSON.stringify({key:r.manifest.key,source:r.manifest.files.source.sha256}));`],
      { env: { PATH: process.env.PATH, ...window.env }, encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ key: window.receipt.key, source: window.receipt.sourceSha });
    expect(await window.freshness()).toMatchObject({ state: "unavailable", qualified: false });
  } finally { await window.dispose(); await f.close(); }
});

test("dependency/test-plan changes have distinct window identities without granting a new ABI pin", async () => {
  const f = await fixture(); const a = await captureHostSourceWindow(f.paths, bindings, { parent: f.parent });
  const b = await captureHostSourceWindow(f.paths, { ...bindings, testPlan: sourceDigest("different-plan") }, { parent: f.parent });
  try { expect(a.receipt.sourceSet).toBe(b.receipt.sourceSet); expect(a.receipt.key).not.toBe(b.receipt.key); expect(a.receipt.qualified).toBe(false); }
  finally { await a.dispose(); await b.dispose(); await f.close(); }
});
