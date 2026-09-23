import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { build, stop } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

type Identity = { version: number; kind: string; sourceDigest: string; compilerVersion: string; sdkVersions: Record<string, string> };
type Reference = { bytes: Uint8Array; sha256: string; build: Identity };
type Proof = { ok: boolean; reason: string; artifact: { sha256: string; bytes: number } | null;
  expected: { sha256: string; build: Identity } | null; executed: false; adoptionAuthorized: false };
const root = fileURLToPath(new URL("../", import.meta.url));
const moduleUrl = new URL("../scripts/preload-artifact.mjs", import.meta.url).href;
const { buildPreloadReference, preloadBuildOptions, verifyPreloadArtifact } = await import(moduleUrl) as {
  buildPreloadReference(root: string): Promise<Reference>;
  preloadBuildOptions(root: string, identity: Identity): Parameters<typeof build>[0];
  verifyPreloadArtifact(root: string, path?: string): Promise<Proof>;
};
let owned: string, candidate: string, reference: Reference;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  // A regular-file copy of this public source tree; never edit real source to
  // create old/changed fixtures. Installed dependencies are read-only links.
  owned = mkdtempSync(join(tmpdir(), "grokbox-preload-proof-"));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const name of new Set(files)) {
    if (!existsSync(join(root, name))) continue; // deleted legacy golden
    const target = join(owned, name);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, name), target);
  }
  symlinkSync(join(root, "node_modules"), join(owned, "node_modules"), "dir");
  for (const name of ["box-runtime", "runtime-kernel", "cli", "client", "server"]) {
    const installed = join(root, "packages", name, "node_modules");
    if (existsSync(installed)) symlinkSync(installed, join(owned, "packages", name, "node_modules"), "dir");
  }
  reference = await buildPreloadReference(owned);
  await stop(); // Release the compiler process owned by setup, not by a test.
  mkdirSync(join(owned, "dist")); candidate = join(owned, "dist/preload.cjs");
}, 30000);
afterEach(async () => { await stop(); });
afterAll(() => { if (owned) rmSync(owned, { recursive: true, force: true }); });

test("an unchanged actual compile is verified by an independent source rebuild without writing it", async () => {
  writeFileSync(candidate, reference.bytes);
  const proof = await verifyPreloadArtifact(owned);
  expect(proof).toMatchObject({ ok: true, reason: "source-bound-rebuild", executed: false, adoptionAuthorized: false });
  expect(proof.expected?.build).toEqual(reference.build);
  expect(sha(readFileSync(candidate))).toBe(reference.sha256);
});

for (const [name, change] of [
  ["appended executable code", (bytes: Uint8Array) => Buffer.concat([bytes, Buffer.from("\nthrow new Error('candidate_must_never_execute');\n")])],
  ["truncation", (bytes: Uint8Array) => bytes.slice(0, bytes.length - 100)],
  ["plausible build identity with wrong body", () => Buffer.from(`module.exports = ${JSON.stringify({ build: { kind: "bundled" } })};`)],
] as const) test(`altered candidate is rejected and remains untouched: ${name}`, async () => {
  const bytes = change(reference.bytes); writeFileSync(candidate, bytes);
  const proof = await verifyPreloadArtifact(owned);
  expect(proof).toMatchObject({ ok: false, reason: "preload_rebuild_mismatch", executed: false });
  expect(sha(readFileSync(candidate))).toBe(sha(bytes));
});

test("empty, missing, directory and symlink candidates are not build proofs", async () => {
  writeFileSync(candidate, ""); expect((await verifyPreloadArtifact(owned)).reason).toBe("preload_size_invalid");
  rmSync(candidate); expect((await verifyPreloadArtifact(owned)).reason).toBe("preload_missing");
  expect((await verifyPreloadArtifact(owned, owned)).reason).toBe("preload_not_regular");
  const target = join(owned, "owned-target.cjs"); writeFileSync(target, reference.bytes); symlinkSync(target, candidate);
  try { expect((await verifyPreloadArtifact(owned)).reason).toBe("preload_not_regular"); }
  finally { rmSync(candidate); }
});

for (const change of ["source", "lock", "protocol"] as const) test(`old bytes are not repaired when current ${change} evolves`, async () => {
  const path = join(owned, change === "lock" ? "bun.lock" : change === "protocol"
    ? "packages/runtime-kernel/src/internal/contract/wire.ts" : "packages/runtime-kernel/src/internal/contract/build-info.ts");
  const original = readFileSync(path, "utf8");
  const next = change === "protocol" ? original.replace("WIRE_VERSION = 8", "WIRE_VERSION = 9") : original + "\n";
  expect(next).not.toBe(original); writeFileSync(candidate, reference.bytes); writeFileSync(path, next);
  try {
    const proof = await verifyPreloadArtifact(owned);
    expect(proof).toMatchObject({ ok: false, reason: "preload_rebuild_mismatch" });
    expect(proof.expected?.build.sourceDigest).not.toBe(reference.build.sourceDigest);
    expect(sha(readFileSync(candidate))).toBe(reference.sha256);
  } finally { writeFileSync(path, original); }
});

for (const field of ["compiler", "sdk", "source"] as const) test(`actual bundle with a false ${field} identity is rejected`, async () => {
  const identity = structuredClone(reference.build);
  if (field === "compiler") identity.compilerVersion = "0.0.0-wrong";
  else if (field === "sdk") identity.sdkVersions.ai = "0.0.0-wrong";
  else identity.sourceDigest = "0".repeat(64);
  const compiled = await build(preloadBuildOptions(owned, identity));
  const bytes = compiled.outputFiles![0]!.contents;
  expect(sha(bytes)).not.toBe(reference.sha256);
  writeFileSync(candidate, bytes);
  expect((await verifyPreloadArtifact(owned)).reason).toBe("preload_rebuild_mismatch");
});

test("a source edit after build capture refuses the in-flight proof", async () => {
  const path = join(owned, "bun.lock"), original = readFileSync(path);
  const pending = buildPreloadReference(owned);
  // The function captures source synchronously, then awaits the compiler. This
  // edit deterministically occurs before its post-build check, without a sleep.
  writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
  try { await expect(pending).rejects.toMatchObject({ code: "preload_source_changed" }); }
  finally { writeFileSync(path, original); }
});

test("an artifact replaced during rebuilding cannot certify either candidate", async () => {
  writeFileSync(candidate, reference.bytes);
  const pending = verifyPreloadArtifact(owned);
  writeFileSync(candidate, Buffer.concat([reference.bytes, Buffer.from("\n// replaced\n")]));
  expect(await pending).toMatchObject({ ok: false, reason: "preload_artifact_changed", executed: false });
});


test("the real context verifier rejects a tampered preload before executing or repairing it", () => {
  const marker = join(owned, "must-not-run");
  const bytes = Buffer.from(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected");`);
  writeFileSync(candidate, bytes);
  const child = spawnSync("node", [join(owned, "scripts/verify-context-continuity.mjs"), "--lane", "artifact-e2e", "--json"], {
    cwd: owned, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: owned, TMPDIR: owned },
  });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
  const report = JSON.parse(child.stdout);
  expect(report.error).toBe("preload_rebuild_mismatch");
  expect(report.artifact.sourceBinding.before).toMatchObject({ ok: false, executed: false });
  expect(report.commands).toBeUndefined(); expect(report.artifact.factoryProbes).toBeNull();
  expect(existsSync(marker)).toBe(false); expect(readFileSync(candidate)).toEqual(bytes);
});
