import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { applyPatchProfile, PACKED_SESSION_SYMBOL, profileFromSource } from "../src/internal/host/profile.ts";
import { hostVisibleStreamError, toHostStreamResult, visibleFailureHandle } from "../src/internal/host/session.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKED = join(repoRoot, "dist", "preload.cjs");
const SESSION_SRC = join(repoRoot, "packages", "box-runtime", "src", "internal", "host", "session.ts");
const OLD_SNIPPET = join(repoRoot, "packages", "box-runtime", "test", "fixtures", "e09-old-error-text-snippet.cjs");
const PACKED_PIN = join(repoRoot, "packages", "box-runtime", "test", "fixtures", "e09-packed-preload.sha256");

function sha256Bytes(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("source Host SHA unit and bun packed smoke", () => {
  test("source Host SHA unknown and transformed mismatch refuse", () => {
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

  test("source visibleFailure constructor is RetriableError", () => {
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

  test("bun smoke: packed preload --require load", () => {
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
      env: {
        ...process.env,
        GROKBOX_ALLOW_LIVE_HOST: "",
        GROKBOX_PACKED_SESSION_FACTORY: "",
        GROKBOX_PACKED_PRELOAD: "",
        GROKBOX_PATCH_PROFILE: "",
        GROKBOX_OPERATION_ID: "",
      },
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toContain("preload-probe-ok");
  });

  test("E09 reject-old oracle: pin matches pack from source", () => {
    expect(existsSync(PACKED_PIN)).toBe(true);
    const pin = readFileSync(PACKED_PIN, "utf8").trim();
    expect(pin).toMatch(/^[a-f0-9]{64}$/);
    expect(pin).not.toBe("0".repeat(64));
    const packed = spawnSync("bun", ["scripts/pack-runtime-helpers.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GROKBOX_ALLOW_LIVE_HOST: "",
        GROKBOX_PACKED_SESSION_FACTORY: "",
        GROKBOX_PACKED_PRELOAD: "",
      },
    });
    expect(packed.status).toBe(0);
    expect(existsSync(PACKED)).toBe(true);
    const bytes = readFileSync(PACKED);
    expect(sha256Bytes(bytes)).toBe(pin);
    expect(sha256Bytes(Buffer.concat([bytes, Buffer.from("\n// drift\n")]))).not.toBe(pin);
    expect(sha256Bytes(Buffer.alloc(0))).not.toBe(pin);
  });

  test("E09 reject-old oracle: old error-text consumer vs source throw", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const old = require(OLD_SNIPPET) as { visibleFailureHandle: (message: string) => { fullStream: AsyncIterable<unknown> } };
    const oldParts: unknown[] = [];
    for await (const part of old.visibleFailureHandle("The model request exceeds the supported envelope limit. No model request was sent.").fullStream) {
      oldParts.push(part);
    }
    expect(oldParts.some((part) => part && typeof part === "object" && (part as { type?: string }).type === "text-delta")).toBe(true);
    const current = toHostStreamResult(visibleFailureHandle("openai/gpt", "invalid_envelope"));
    const currentParts: unknown[] = [];
    let threw: Error | undefined;
    try {
      for await (const part of current.fullStream) currentParts.push(part);
    } catch (error) {
      threw = error instanceof Error ? error : new Error(String(error));
    }
    expect(threw?.name).toBe("RetriableError");
    expect(currentParts.some((part) => part && typeof part === "object" && (part as { type?: string }).type === "text-delta")).toBe(false);
    await expect(current.response).rejects.toBeDefined();
  });

  test("default packed --require does not install session factory", () => {
    const probe = spawnSync(process.execPath, [
      "--require",
      PACKED,
      "-e",
      `process.stdout.write(String(globalThis[Symbol.for(${JSON.stringify(PACKED_SESSION_SYMBOL)})] == null))`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GROKBOX_ALLOW_LIVE_HOST: "",
        GROKBOX_PACKED_SESSION_FACTORY: "",
        GROKBOX_PACKED_PRELOAD: "",
        GROKBOX_PATCH_PROFILE: "",
        GROKBOX_OPERATION_ID: "",
      },
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("true");
  });
});
