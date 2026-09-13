import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureVerificationSource, withVerificationSource } from "../scripts/verification-source.mjs";

test("verification input hash detects content, added files and deletions while ignoring generated files", () => {
  const root = mkdtempSync(join(tmpdir(), "gbox-source-proof-"));
  try {
    writeFileSync(join(root, "input.ts"), "first");
    const before = captureVerificationSource(root, ["input.ts"]);
    expect(before.ok).toBe(true);
    expect(captureVerificationSource(root, ["input.ts"])).toEqual(before);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/output.js"), "built artifact");
    expect(captureVerificationSource(root, ["input.ts"])).toEqual(before);
    writeFileSync(join(root, "input.ts"), "second");
    const changed = captureVerificationSource(root, ["input.ts"]);
    expect(changed.sha256).not.toBe(before.sha256);
    writeFileSync(join(root, "added.ts"), "new source");
    expect(captureVerificationSource(root, ["input.ts", "added.ts"]).sha256).not.toBe(changed.sha256);
    rmSync(join(root, "input.ts"));
    const deleted = captureVerificationSource(root, ["input.ts"]);
    expect(deleted.ok).toBe(true);
    expect(deleted.sha256).not.toBe(changed.sha256);
    expect(captureVerificationSource(root, ["input.ts"])).toEqual(deleted);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("passing tests on changed or unavailable sources cannot qualify a candidate", () => {
  const pass = { ok: true, supports: ["bounded-case"], notProven: ["live"], asserts: { pass: 10, fail: 0 } };
  const before = { ok: true, sha256: "a", files: 1 };
  expect(withVerificationSource(pass, before, before)).toMatchObject({ ok: true, source: { stable: true } });
  for (const after of [{ ok: true, sha256: "b", files: 1 }, { ok: false, reason: "unavailable" }]) {
    const result = withVerificationSource(pass, before, after);
    expect(result.ok).toBe(false);
    expect(result.supports).toEqual([]);
    expect(result.error).toBe("verification_source_changed");
    expect(result.notProven).toEqual(["live", "source_consistency"]);
    expect(result.asserts).toEqual(pass.asserts);
  }
  expect(withVerificationSource({ ok: false, error: "toolchain_mismatch" }, before, before).error).toBe("toolchain_mismatch");
});

test("source fingerprint refuses aliases and directories without exposing contents", () => {
  const root = mkdtempSync(join(tmpdir(), "gbox-source-alias-"));
  try {
    writeFileSync(join(root, "input.ts"), "source fixture");
    symlinkSync(join(root, "input.ts"), join(root, "alias.ts"));
    expect(captureVerificationSource(root, ["alias.ts"]).ok).toBe(false);
    expect(captureVerificationSource(root, ["."]).ok).toBe(false);
    expect(captureVerificationSource(root, ["../outside"]).ok).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
