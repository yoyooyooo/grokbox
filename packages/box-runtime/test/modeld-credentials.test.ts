import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  CREDENTIAL_SECRET_MAX_BYTES,
  fingerprintApiKeyRef,
  fingerprintSecret,
  materializeApiKeyRef,
} from "../src/internal/io/credentials.node.ts";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grokbox-c1-"));
}

describe("modeld C1 credentials", () => {
  test("env hit trims; miss/empty fail; fingerprint is stable sha256 hex", async () => {
    const env = { OPENAI_API_KEY: "  sk-offline\n" };
    const secret = await materializeApiKeyRef("env:OPENAI_API_KEY", env);
    expect(secret).toBe("sk-offline");
    const fp = await fingerprintApiKeyRef("env:OPENAI_API_KEY", env);
    expect(fp).toBe(sha256Text("sk-offline"));
    expect(fp).toBe(fingerprintSecret(secret));
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(fp).toBe(await fingerprintApiKeyRef("env:OPENAI_API_KEY", env));
    expect(JSON.stringify({ fp })).not.toContain("sk-offline");

    await expect(materializeApiKeyRef("env:MISSING", {})).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("env:EMPTY", { EMPTY: "" })).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("env:BLANK", { BLANK: "  \n\t" })).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("sk-live", { OPENAI_API_KEY: "x" })).rejects.toBeInstanceOf(BoxRuntimeError);
  });

  test("file hit/miss/too-large/non-regular; env and file fingerprint the same trimmed payload", async () => {
    const dir = await tmpDir();
    const file = join(dir, "key");
    await writeFile(file, "  sk-file\n", { mode: 0o600 });
    expect(await materializeApiKeyRef(`file:${file}`, {})).toBe("sk-file");
    expect(await fingerprintApiKeyRef(`file:${file}`, {})).toBe(sha256Text("sk-file"));
    expect(await fingerprintApiKeyRef("env:K", { K: "sk-file" })).toBe(sha256Text("sk-file"));

    const blank = join(dir, "blank");
    await writeFile(blank, "\n  \n");
    await expect(materializeApiKeyRef(`file:${blank}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    await expect(materializeApiKeyRef(`file:${join(dir, "missing")}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const huge = join(dir, "huge");
    await writeFile(huge, "x".repeat(CREDENTIAL_SECRET_MAX_BYTES + 1));
    await expect(materializeApiKeyRef(`file:${huge}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const nested = join(dir, "nested");
    await mkdir(nested);
    await expect(materializeApiKeyRef(`file:${nested}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const link = join(dir, "link");
    await symlink(file, link);
    await expect(materializeApiKeyRef(`file:${link}`, {})).rejects.toMatchObject({ code: "credential_invalid" });
  });

  test("Promise facade maps already-aborted signal to cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(materializeApiKeyRef("env:K", { K: "v" }, ac.signal)).rejects.toThrow(/cancelled/);
  });
});
