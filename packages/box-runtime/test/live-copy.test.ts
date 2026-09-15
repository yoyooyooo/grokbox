import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { join } from "node:path";
import { transformCompileInput } from "../src/internal/host/compile-hook.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, extractContractSlices, profileFromSource } from "../src/internal/host/profile.ts";

async function liveSnapshot(): Promise<{ digest: string | null; pids: string[] }> {
  let digest: string | null = null;
  try {
    digest = sha256Bytes(await readFile(LIVE_HOST_BUNDLE));
  } catch {
    digest = null;
  }
  const pids: string[] = [];
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      if (line.includes("host-main.cjs")) pids.push(line.trim().split(/\s+/, 1)[0] ?? "");
    }
  } catch {
    /* ignore */
  }
  return { digest, pids: pids.filter(Boolean) };
}

const describeLive = existsSync(LIVE_HOST_BUNDLE) ? describe : describe.skip;

describeLive("live Host bundle copy H1", () => {
  test("unique approved-slice transform on a tmp copy; live file and PIDs unchanged", async () => {
    const before = await liveSnapshot();
    expect(before.digest).toBeTruthy();
    const dir = join(tmpdir(), `grokbox-live-copy-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const copyPath = join(dir, "host-main.cjs");
    await copyFile(LIVE_HOST_BUNDLE, copyPath);
    const source = await readFile(copyPath, "utf8");
    const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "live-copy");
    const result = applyPatchProfile(source, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("agentId: host.getConversationId()");
    expect(result.source).toContain("invocationId: inferenceRequestId");
    expect(result.source).toContain("if (__grokbox_session !== undefined) return __grokbox_session");
    expect(result.source).toContain("grokbox.box-runtime.host-compact.v1");
    expect(result.source).toContain('purpose: "memory-extraction", turnId: ctx.get(requestIdKey), ctx');
    expect(result.source).toContain('purpose: "episode", turnId: ctx.get(requestIdKey), ctx');
    expect(profile.slices.map((slice) => slice.id)).toContain("memory-purpose");
    expect(profile.slices.map((slice) => slice.id)).toContain("episode-purpose");
    expect(profile.slices.map((slice) => slice.id)).toContain("harness-blank");
    expect(profile.slices.map((slice) => slice.id)).toContain("harness-summary");
    expect(profile.slices.map((slice) => slice.id)).toContain("profile-title-marker");
    expect(result.source).toContain("grokbox.box-runtime.profile-title.v1");
    expect((profile.slices.map((slice) => slice.id) as string[])).not.toContain("harness-local-write");
    expect((profile.slices.map((slice) => slice.id) as string[])).not.toContain("harness-server-write");
    expect(result.source).not.toContain("grokbox.box-runtime.harness-stick.v1");
    expect(result.source).toContain(
      'harness: readSandProfileHarness(profilePath) ?? undefined',
    );
    expect(result.source).not.toContain('? { harness: "temporal" } : {}');
    // Syntax-compile only. Never execute the native Host bundle or its consumers.
    expect(() => new Script(result.source, { filename: copyPath })).not.toThrow();
    const compiled = transformCompileInput({
      content: source,
      filename: copyPath,
      targetPath: copyPath,
      profile,
    });
    expect(compiled.transformed).toBe(true);
    expect(compiled.refused).toBeUndefined();
    const extracted = extractContractSlices(result.source);
    expect(extracted["create-session"]).toContain("createSession(onRequestId, sessionOptions)");
    expect(extracted["session-options"]).toContain("const mainSessionOptions");
    expect(extracted["agent-id"]).toContain("agentId: host.getConversationId()");
    expect(extracted["agent-id"]).toContain("invocationId: inferenceRequestId");
    const liveBlocked = transformCompileInput({
      content: source,
      filename: LIVE_HOST_BUNDLE,
      targetPath: LIVE_HOST_BUNDLE,
      profile,
    });
    expect(liveBlocked.transformed).toBe(false);
    expect(liveBlocked.refused).toBe("live-host-blocked");
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    expect(before.digest).toBeTruthy();
    if (!before.digest) return;
    expect(sha256Bytes(await readFile(LIVE_HOST_BUNDLE))).toBe(before.digest);
    expect(await readFile(copyPath, "utf8")).toBe(source);
  });
});
