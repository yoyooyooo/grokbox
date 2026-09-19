import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { transformNativeCheckpointWorker, NATIVE_CHECKPOINT_PAIR } from "../src/internal/host/native-checkpoint-worker-hook.ts";
import { NATIVE_CHECKPOINT_HOST_SLICES } from "../src/internal/host/native-checkpoint-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "../src/internal/host/native-current-state-slices.ts";
import { OBSERVATION_SLICE_IDS, profileFromSource, preflightProfileRecipe } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { upgradeProfileCapability } from "../src/internal/host/profile-capabilities.ts";
import { envelopeProfileShape, envelopeWindowsFromRecipe, parseEnvelopeWindows } from "../src/internal/ops/host-seam/envelope-windows.ts";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
const repository = resolve(import.meta.dir, "../../..");
test("worker transform refuses all unqualified source before creating a binding", () => {
  expect(() => transformNativeCheckpointWorker("const fake = 1")).toThrow("unqualified");
});
nativeTest("all new Host slices have unique original anchors and exact worker wrapper advertises its protocol", async () => {
  const host = await readFile("/home/box/sand-host/host-main.cjs", "utf8");
  expect(sha256Bytes(new TextEncoder().encode(host))).toBe(NATIVE_CHECKPOINT_PAIR.host);
  const worker = await readFile("/home/box/sand-host/agent-isolation/agent-store-worker.cjs", "utf8");
  expect(transformNativeCheckpointWorker(worker)).toContain("grokboxCheckpointProtocol: 1");
  const report = preflightProfileRecipe(host, [...NATIVE_CHECKPOINT_HOST_SLICES, ...NATIVE_CURRENT_STATE_SLICES]);
  expect(report.ok, JSON.stringify(report.ok ? { ok: true } : report)).toBe(true);
}, 30000);

nativeTest("explicit current-state upgrade preserves its baseline and measures the complete new envelope group", async () => {
  const source = await readFile("/home/box/sand-host/host-main.cjs", "utf8");
  // Owned reviewed-baseline shape, NOT permission to drop an installed observer.
  // The existing writer still requires same-source baseline and exact review.
  const baseline = profileFromSource(source, LIVE_SLICE_PATCHES.filter(slice => !(OBSERVATION_SLICE_IDS as readonly string[]).includes(slice.id)));
  const before = JSON.stringify(baseline);
  const upgraded = upgradeProfileCapability(source, baseline, "current-state");
  expect(upgraded.addedIds.map(String).sort()).toEqual([
    "continuity-native-worker-handshake","continuity-native-worker-client","continuity-native-blob-owner",
    "continuity-native-run-fence","continuity-native-session-owner","continuity-native-checkpoint-fence","continuity-native-checkpoint-revision",
    "continuity-native-rpc-schema","continuity-native-rpc-api","continuity-native-created-owner","continuity-native-duplicate-identity",
    "continuity-native-history-boundary","continuity-native-instructions","continuity-native-history-position",
    "continuity-native-birth-options","continuity-native-birth-background","continuity-native-birth-fence","continuity-native-prepared-load",
    "continuity-native-startup-input","continuity-native-startup-action","continuity-native-startup-scheduler","continuity-native-startup-no-user-prompt",
  ].sort()); expect(JSON.stringify(baseline)).toBe(before);
  const profile = profileFromSource(source, upgraded.slices);
  expect(envelopeProfileShape(profile)).toBe(true);
  const windows = envelopeWindowsFromRecipe(source, profile); expect(windows).not.toBeNull();
  expect(parseEnvelopeWindows(windows).slices.length).toBeGreaterThan(26);
  expect(envelopeProfileShape({ ...profile, slices: profile.slices.filter(s => s.id !== "continuity-native-run-fence") })).toBe(false);
}, 30000);

nativeTest("actual original worker threads persist their own transactions, receipts and preparation fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-original-worker-"));
  try {
    await writeFile(join(root, "owned-marker"), "grokbox-original-worker", { mode: 0o600 });
    await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const worker = join(root, "worker.cjs"), driver = join(root, "driver.mjs");
    await build({ entryPoints: [join(import.meta.dir, "fixtures/native-worker-thread-entry.ts")], absWorkingDir: repository,
      bundle: true, platform: "node", target: "node22", format: "cjs", outfile: worker, logLevel: "silent" });
    await build({ entryPoints: [join(import.meta.dir, "fixtures/native-worker-driver.ts")], absWorkingDir: repository,
      bundle: true, platform: "node", target: "node22", format: "esm", external: ["typescript"], outfile: driver,
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, logLevel: "silent" });
    // The original worker requires node:sqlite. This is the native runtime's
    // qualification, not permission to raise grokbox's Node20 product baseline.
    const node = process.env.GROKBOX_TEST_NATIVE_NODE ?? "/exec-daemon/node";
    const result = spawnSync(node, [driver, root, worker], { encoding: "utf8", timeout: 60000, cwd: root,
      env: { PATH: process.env.PATH, HOME: root, GROKBOX_TEST_NATIVE_CONTINUITY: "1", NODE_NO_WARNINGS: "1" } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ originalWorker: true, nativeSqlite: true, protocol: 1, prepareReadOnly: true,
      durableReceipt: true, persistentGcFence: true, b2Preserved: true, startedBot: false, providerRequests: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90000);
