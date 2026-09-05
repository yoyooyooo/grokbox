import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCompileHook, transformCompileInput } from "../src/hook.ts";
import { LIVE_HOST_BUNDLE } from "../src/live-slices.ts";
import { profileFromSource } from "../src/transform.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

describe("compile hook", () => {
  test("transforms only the target copy and never the live Host path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-hook-"));
    const target = join(dir, "host-main.cjs");
    await writeFile(target, SYNTHETIC_HOST);
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const hit = transformCompileInput({
      content: SYNTHETIC_HOST,
      filename: target,
      targetPath: target,
      profile,
    });
    expect(hit.transformed).toBe(true);
    expect(hit.content).toContain("agentId: host.getConversationId()");
    expect(hit.content).toContain("originalSession: session");

    const other = transformCompileInput({
      content: SYNTHETIC_HOST,
      filename: join(dir, "other.cjs"),
      targetPath: target,
      profile,
    });
    expect(other.transformed).toBe(false);
    expect(other.content).toBe(SYNTHETIC_HOST);

    const liveBlocked = transformCompileInput({
      content: SYNTHETIC_HOST,
      filename: LIVE_HOST_BUNDLE,
      targetPath: LIVE_HOST_BUNDLE,
      profile,
    });
    expect(liveBlocked).toMatchObject({ transformed: false, refused: "live-host-blocked" });
    expect(liveBlocked.content).toBe(SYNTHETIC_HOST);
  });

  test("--box-copy-in does not install the hook; restore leaves Module alone", async () => {
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const blocked = installCompileHook({
      targetPath: "/tmp/host-main.cjs",
      profile,
      argv: ["node", "/tmp/host-main.cjs", "--box-copy-in"],
    });
    expect(blocked.refused).toBe("argv-blocked");
    expect(blocked.applied()).toBe(false);

    const live = installCompileHook({
      targetPath: LIVE_HOST_BUNDLE,
      profile,
      argv: ["node", LIVE_HOST_BUNDLE],
    });
    expect(live.refused).toBe("live-host-blocked");
    expect(live.applied()).toBe(false);
  });

  test("hook compile writes no files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-hook-"));
    const target = join(dir, "host-main.cjs");
    await writeFile(target, SYNTHETIC_HOST);
    const before = await stat(target);
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const hit = transformCompileInput({
      content: SYNTHETIC_HOST,
      filename: target,
      targetPath: target,
      profile,
    });
    expect(hit.transformed).toBe(true);
    const after = await stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(target, "utf8")).toBe(SYNTHETIC_HOST);
  });
});
