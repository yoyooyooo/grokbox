import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { applyHarnessStick, asProfileHarness, bindHarnessStickHook } from "../src/internal/host/harness-stick.ts";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { HOST_HARNESS_STICK_SYMBOL, profileFromSource, transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const STICK_SLICES = LIVE_SLICE_PATCHES.filter((slice) =>
  slice.id === "harness-profile-rpc" ||
  slice.id === "harness-update-trim" ||
  slice.id === "harness-agent-write" ||
  slice.id === "harness-local-write" ||
  slice.id === "harness-server-write"
);

describe("L2c harness stickiness", () => {
  test("asProfileHarness is fail-closed", () => {
    expect(asProfileHarness("box")).toBe("box");
    expect(asProfileHarness("temporal")).toBe("temporal");
    expect(asProfileHarness("server")).toBeUndefined();
    expect(asProfileHarness("")).toBeUndefined();
    expect(asProfileHarness(undefined)).toBeUndefined();
  });

  test("local write: incoming box|temporal wins; else keep existing", () => {
    expect(applyHarnessStick({ kind: "local", incoming: "box", existing: "temporal" })).toBe("box");
    expect(applyHarnessStick({ kind: "local", incoming: "temporal", existing: "box" })).toBe("temporal");
    expect(applyHarnessStick({ kind: "local", incoming: undefined, existing: "box" })).toBe("box");
    expect(applyHarnessStick({ kind: "local", incoming: "nope", existing: "temporal" })).toBe("temporal");
    expect(applyHarnessStick({ kind: "local" })).toBeUndefined();
  });

  test("server write: existing file never takes remote harness; omit is box", () => {
    expect(applyHarnessStick({ kind: "server", fileExists: true, existing: "box", remote: "temporal" })).toBe("box");
    expect(applyHarnessStick({ kind: "server", fileExists: true, existing: "temporal", remote: "box" })).toBe("temporal");
    expect(applyHarnessStick({ kind: "server", fileExists: true, existing: undefined, remote: "temporal" })).toBe("box");
    expect(applyHarnessStick({ kind: "server", fileExists: false, remote: "temporal" })).toBe("temporal");
    expect(applyHarnessStick({ kind: "server", fileExists: false, remote: "box" })).toBe("box");
    expect(applyHarnessStick({ kind: "server", fileExists: false })).toBeUndefined();
    expect(applyHarnessStick({ kind: "server", fileExists: "yes", existing: "box" })).toBeUndefined();
  });

  test("invalid input and hook throw decline to official", () => {
    expect(applyHarnessStick(null)).toBeUndefined();
    expect(applyHarnessStick("local")).toBeUndefined();
    expect(applyHarnessStick({ kind: "other", incoming: "box" })).toBeUndefined();
    const hook = bindHarnessStickHook();
    expect(hook({ kind: "local", incoming: "box" })).toBe("box");
    expect(hook(undefined)).toBeUndefined();
  });

  test("stick slices apply on the live-shaped fixture and keep always-emit", () => {
    const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(HOST_HARNESS_STICK_SYMBOL);
    expect(applied.source).toContain('kind: "local"');
    expect(applied.source).toContain('kind: "server"');
    expect(applied.source).toContain("harness: rpcOptional(");
    expect(applied.source).toContain('...profile.harness === "box" || profile.harness === "temporal" ? { harness: profile.harness } : {}');
    expect(applied.source).toContain(
      'harness: readSandProfileHarness(profilePath) === "temporal" ? "temporal" : "box"',
    );
    expect(applied.source).not.toContain('? { harness: "temporal" } : {}');
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "harness-stick-shaped");
    expect(profile.slices.map((slice) => slice.id)).toEqual(LIVE_SLICE_PATCHES.map((slice) => slice.id));
    expect(STICK_SLICES).toHaveLength(5);
  });

  test.each(STICK_SLICES)("$id startAnchor is before find and fail-closed on missing/duplicate", (slice) => {
    expect(slice.startAnchor.includes(slice.find) || LIVE_SHAPED_HOST.indexOf(slice.startAnchor) < LIVE_SHAPED_HOST.indexOf(slice.find)).toBe(true);
    expect(transformUnchecked(LIVE_SHAPED_HOST.replace(slice.startAnchor, ""), [slice])).toMatchObject({
      ok: false,
      code: "anchor-missing",
    });
    expect(transformUnchecked(LIVE_SHAPED_HOST + slice.startAnchor, [slice])).toMatchObject({
      ok: false,
      code: "anchor-duplicate",
    });
  });

  test("transformed writers keep sticky box across name write and server stamp", () => {
    const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const localStart = applied.source.indexOf("function writeSandProfileFile(path31, profile) {");
    const localEnd = applied.source.indexOf("function seedRoomProfileName(seed) {", localStart);
    const serverStart = applied.source.indexOf("function writeServerBackedProfileFile(path31, profile, binding) {");
    const serverEnd = applied.source.indexOf("function isServerTemporalHarnessRefusal(error41) {", serverStart);
    expect(localStart).toBeGreaterThan(-1);
    expect(serverStart).toBeGreaterThan(-1);
    const files = new Map<string, Record<string, unknown>>();
    const sandbox: Record<string | symbol, unknown> = {
      Symbol,
      parseProfileJson2: (path: string) => files.get(path) ?? null,
      profileServerBindingFromJson: (parsed: Record<string, unknown>) => ({
        ...typeof parsed.serverId === "string" ? { serverId: parsed.serverId } : {},
        ...parsed.harness === "box" || parsed.harness === "temporal" ? { harness: parsed.harness } : {},
      }),
      serializeSandProfileFile: (profile: Record<string, unknown>, binding: Record<string, unknown>) =>
        JSON.stringify({ ...profile, ...binding }),
      writeProfileJson: (path: string, serialized: string) => {
        files.set(path, JSON.parse(serialized) as Record<string, unknown>);
      },
      readSandProfileCreationMetadata: () => ({}),
    };
    sandbox[Symbol.for(HOST_HARNESS_STICK_SYMBOL)] = bindHarnessStickHook();
    const ctx = runInNewContext(
      `${applied.source.slice(localStart, localEnd)}\n${applied.source.slice(serverStart, serverEnd)}\n({ writeSand: writeSandProfileFile, writeServer: writeServerBackedProfileFile })`,
      sandbox,
    ) as {
      writeSand: (path: string, profile: Record<string, unknown>) => void;
      writeServer: (path: string, profile: Record<string, unknown>, binding: Record<string, unknown>) => void;
    };

    const path = "/tmp/l2c-stick-profile.json";
    ctx.writeSand(path, { name: "canary", description: "", harness: "box" });
    expect(files.get(path)?.harness).toBe("box");
    ctx.writeSand(path, { name: "renamed", description: "" });
    expect(files.get(path)?.harness).toBe("box");
    ctx.writeServer(path, { name: "renamed", description: "" }, { serverId: "1607420", harness: "temporal" });
    expect(files.get(path)?.harness).toBe("box");
    expect(files.get(path)?.serverId).toBe("1607420");
    ctx.writeSand(path, { name: "renamed", description: "", harness: "temporal" });
    expect(files.get(path)?.harness).toBe("temporal");
    ctx.writeServer("/tmp/l2c-new-profile.json", { name: "fresh", description: "" }, {
      serverId: "1",
      harness: "temporal",
    });
    expect(files.get("/tmp/l2c-new-profile.json")?.harness).toBe("temporal");
  });

  test("preload binds the stick hook for admitted Host compiles", async () => {
    const preload = await Bun.file(new URL("../src/preload.ts", import.meta.url)).text();
    expect(preload).toContain("bindHarnessStickHook()");
    expect(preload).toContain("HOST_HARNESS_STICK_SYMBOL");
    const packed = fileURLToPath(new URL("../../../dist/preload.cjs", import.meta.url));
    if (existsSync(packed)) {
      const text = await Bun.file(packed).text();
      expect(text).toContain(HOST_HARNESS_STICK_SYMBOL);
      expect(text).toContain("bindHarnessStickHook()");
    }
  });
});

const describeLive = existsSync(LIVE_HOST_BUNDLE) ? describe : describe.skip;
describeLive("L2c live Host copy stick slices", () => {
  test("approved stick slices apply on a read-only live copy", () => {
    const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
    const applied = transformUnchecked(source, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(HOST_HARNESS_STICK_SYMBOL);
    expect(applied.source).toContain('kind: "local"');
    expect(applied.source).toContain('kind: "server"');
    expect(readFileSync(LIVE_HOST_BUNDLE, "utf8")).toBe(source);
  });
});
