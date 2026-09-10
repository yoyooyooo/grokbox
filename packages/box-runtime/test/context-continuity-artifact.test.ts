import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { applyPatchProfile, profileFromSource } from "../src/internal/host/profile.ts";
import { hostVisibleStreamError } from "../src/internal/host/session.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKED = join(repoRoot, "dist", "preload.cjs");
const SESSION_SRC = join(repoRoot, "packages", "box-runtime", "src", "internal", "host", "session.ts");
const OLD_SNIPPET = join(repoRoot, "packages", "box-runtime", "test", "fixtures", "e09-old-error-text-snippet.cjs");

function sha256Bytes(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("E09 source vs artifact SHA and old-dist refuse", () => {
  test("E09 unknown Host SHA and transformed mismatch refuse", () => {
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "e09");
    expect(applyPatchProfile(`${SYNTHETIC_HOST}\n// drift\n`, profile)).toMatchObject({ ok: false, code: "unknown-sha" });
    expect(applyPatchProfile(SYNTHETIC_HOST, { ...profile, transformedSourceSha256: "0".repeat(64) })).toMatchObject({
      ok: false,
      code: "transformed-mismatch",
    });
    const applied = applyPatchProfile(SYNTHETIC_HOST, profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.transformedSha256).toBe(sha256Text(applied.source));
    expect(applied.sourceSha256).toBe(profile.sourceSha256);
  });

  test("E09 current source errors are RetriableError, not old text-delta", () => {
    const src = readFileSync(SESSION_SRC, "utf8");
    expect(src).toContain("hostVisibleStreamError");
    expect(src).toContain("RetriableError");
    expect(src).not.toContain("yield { type: \"text-delta\", textDelta: message }");
    const err = hostVisibleStreamError({ userVisible: true, code: "invalid_envelope", message: "The model request exceeds the supported envelope limit. No model request was sent." });
    expect(err.name).toBe("RetriableError");
    const old = readFileSync(OLD_SNIPPET, "utf8");
    expect(old).toContain("yield { type: \"text-delta\", textDelta: message }");
    expect(src.includes("yield { type: \"text-delta\", textDelta: message }")).toBe(false);
  });

  test("E09 packed preload SHA mismatches a mutated copy; unknown packed SHA is not current", () => {
    expect(existsSync(PACKED)).toBe(true);
    const bytes = readFileSync(PACKED);
    const sha = sha256Bytes(bytes);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Bytes(Buffer.concat([bytes, Buffer.from("\n// old-dist\n")]))).not.toBe(sha);
    expect(sha).not.toBe("0".repeat(64));
    const packed = bytes.toString("utf8");
    expect(packed).not.toContain("yield { type: \"text-delta\", textDelta: message }");
    const probe = spawnSync(process.execPath, ["--require", PACKED, "-e", "process.stdout.write('preload-probe-ok')"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GROKBOX_ALLOW_LIVE_HOST: "", GROKBOX_PATCH_PROFILE: "", GROKBOX_OPERATION_ID: "" },
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toContain("preload-probe-ok");
  });
});
